import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { openDb } from "../lib/db";
import { exportCmsSnapshot } from "../lib/pipeline/cms-snapshots";
import { runDaily } from "../lib/pipeline/daily-runner";

async function main() {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(["db", "input", "run", "year", "artifacts", "source-db", "release", "plans", "captured-at"].map((key) => [key, { type: "string" as const }])),
    commit: { type: "boolean", default: false },
  } });
  const v = values as Record<string, string | boolean | undefined>;
  const required = (key: string) => { const value = v[key]; if (typeof value !== "string" || !value) throw new Error(`Missing --${key}`); return value; };
  if (!!v.input === !!v["source-db"]) throw new Error("Choose exactly one of --input or --source-db");
  const result = await runDaily({ dbPath: String(v.db ?? "data/eliquis-daily.duckdb"), runId: required("run"), sourceYear: Number(required("year")), commit: !!v.commit, artifactRoot: String(v.artifacts ?? "data/raw/daily"), acquire: async () => {
    if (v.input) return fs.readFile(String(v.input), "utf8");
    const source = await openDb({ path: required("source-db"), readOnly: true });
    try { return JSON.stringify(await exportCmsSnapshot(source, required("release"), JSON.parse(await fs.readFile(required("plans"), "utf8")), required("captured-at"))); }
    finally { await source.close(); }
  } });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "failed") process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Daily runner failed"); process.exitCode = 1; });
