import fs from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// Thin database layer. The backing store is a local DuckDB file (same schema as Postgres,
// see data/schema.sql) because DATABASE_URL is not configured yet. All SQL in lib/ uses
// $1-style params and portable syntax so a Postgres adapter can implement this interface later.

export type SqlValue = string | number | boolean | null;

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  path?: string;
  readOnly?: boolean;
}

// scenario.duckdb is the post-merge database: minimal patients, v1, and v2-cms.
// data/ruined.duckdb is the pre-merge 20-patient file. It is not the app database.
export const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "scenario.duckdb");

export function dbPath(): string {
  return process.env.RUINED_DB || DEFAULT_DB_PATH;
}

/**
 * Open a temporary copy of the app database for read-only tests. Avoids fighting the
 * Next.js server's write lock on data/scenario.duckdb (DuckDB allows one writer).
 */
export async function openDbSnapshot(label = "test"): Promise<{ db: Db; path: string }> {
  const src = dbPath();
  if (!fs.existsSync(src)) throw new Error(`Database not found: ${src}`);
  const dest = `${src}.${label}.${process.pid}.duckdb`;
  fs.copyFileSync(src, dest);
  const db = await openDb({ path: dest, readOnly: true });
  return { db, path: dest };
}

export async function closeDbSnapshot(handle: { db: Db; path: string }): Promise<void> {
  await handle.db.close();
  fs.rmSync(handle.path, { force: true });
  fs.rmSync(`${handle.path}.wal`, { force: true });
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

function schemaStatements(): string[] {
  const sql = fs.readFileSync(path.join(process.cwd(), "data", "schema.sql"), "utf8");
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

class DuckDb implements Db {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private instance: DuckDBInstance,
    private conn: DuckDBConnection,
  ) {}

  // One connection, queries run one at a time.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.enqueue(async () => {
      const reader = await this.conn.runAndReadAll(sql, params);
      return reader.getRowObjectsJS().map(normalizeRow) as T[];
    });
  }

  run(sql: string, params: SqlValue[] = []): Promise<void> {
    return this.enqueue(async () => {
      await this.conn.run(sql, params);
    });
  }

  async close(): Promise<void> {
    await this.chain;
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

export async function openDb(opts: OpenDbOptions = {}): Promise<Db> {
  const file = opts.path ?? dbPath();
  const instance = await DuckDBInstance.create(file, opts.readOnly ? { access_mode: "READ_ONLY" } : {});
  const conn = await instance.connect();
  const db = new DuckDb(instance, conn);
  if (!opts.readOnly) {
    for (const stmt of schemaStatements()) await db.run(stmt);
  }
  return db;
}

// Shared read-write handle for the Next.js server and scripts (survives dev-server HMR).
const g = globalThis as unknown as { __ruinedDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!g.__ruinedDb) {
    g.__ruinedDb = openDb().catch((err) => {
      g.__ruinedDb = undefined;
      throw err;
    });
  }
  return g.__ruinedDb;
}
