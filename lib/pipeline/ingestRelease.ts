import { getDb, type Db } from "../db";

// Registers a loaded CMS release as a data_version row (see DATA_MODEL.md). Idempotent on
// file_hash: this function does NOT parse CMS files itself -- that stays scripts/load_spuf.py
// and scripts/load_puf_monthly.py's job, run separately -- it only owns the release-tracking
// metadata (source, release date, file hash, when we saw it), so it assumes the plans/
// formulary/beneficiary_cost/pricing rows for `dataVersion` are already loaded under that same
// id. See PROGRESS.md task 2 for why this split makes sense.

export interface ManifestEntry {
  /** Matches plans.data_version / formulary.data_version / etc, e.g. 'v1', 'v2-cms'. */
  dataVersion: string;
  source: string;
  /** YYYY-MM-DD */
  releaseDate: string;
  filePath: string;
  /** sha256 of the file at filePath. Null when the source file is no longer available to hash
   * (e.g. a release ingested before this pipeline existed, whose raw zip was already deleted --
   * data/raw is gitignored and not needed once loaded). A null hash is only ever compared to
   * itself: re-ingesting the same id is still idempotent, it just can't detect a same-id/
   * different-content replacement the way a real hash can. */
  fileHash: string | null;
}

export interface DataVersionRow {
  id: string;
  source: string;
  releaseDate: string | null;
  fileHash: string | null;
  loadedAt: string;
}

interface DataVersionDbRow {
  id: string;
  source: string;
  release_date: string | null;
  file_hash: string | null;
  loaded_at: string;
}

const toRow = (r: DataVersionDbRow): DataVersionRow => ({
  id: r.id,
  source: r.source,
  releaseDate: r.release_date,
  fileHash: r.file_hash,
  loadedAt: r.loaded_at,
});

async function findExisting(conn: Db, id: string): Promise<DataVersionDbRow | undefined> {
  const rows = await conn.query<DataVersionDbRow>(
    "SELECT id, source, release_date, file_hash, loaded_at FROM data_versions WHERE id = $1",
    [id],
  );
  return rows[0];
}

export async function ingestRelease(entry: ManifestEntry, db?: Db): Promise<DataVersionRow> {
  const conn = db ?? (await getDb());
  const existing = await findExisting(conn, entry.dataVersion);

  if (existing && (entry.fileHash === null || existing.file_hash === entry.fileHash)) {
    return toRow(existing); // same release already registered -- no-op
  }
  if (existing) {
    // Same id, a real and different hash: a genuinely new release replacing this label's
    // metadata. We only update the bookkeeping row -- reloading plans/formulary/etc for this
    // id is the Python loaders' job (run separately; see scripts/run-pipeline.ts).
    await conn.run("DELETE FROM data_versions WHERE id = $1", [entry.dataVersion]);
  }

  await conn.run(
    `INSERT INTO data_versions (id, source, release_date, file_hash, loaded_at)
     VALUES ($1, $2, CAST($3 AS DATE), $4, CURRENT_TIMESTAMP)`,
    [entry.dataVersion, entry.source, entry.releaseDate, entry.fileHash],
  );
  const inserted = await findExisting(conn, entry.dataVersion);
  if (!inserted) throw new Error("unreachable: just inserted this row");
  return toRow(inserted);
}
