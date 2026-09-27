import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../lib/db";
import { initializeAggregate } from "../lib/pipeline/aggregate-store";
import { runDemo } from "../lib/pipeline/demo";

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string", default: "data/raw/eliquis-demo.json" } } });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "eliquis-demo-"));
  try {
    const results = [];
    for (let pass = 0; pass < 2; pass++) {
      const db = await openDb({ path: ":memory:" });
      try { await initializeAggregate(db); results.push(await runDemo(db, temporary)); }
      finally { await db.close(); }
    }
    assert.deepEqual(results[0], results[1], "Independent offline passes differ");
    await fs.mkdir(path.dirname(values.output!), { recursive: true });
    await fs.writeFile(values.output!, JSON.stringify({ ...results[0], independentRunsMatch: true }, null, 2) + "\n");
    console.log(JSON.stringify({ output: values.output, independentRunsMatch: true, ...results[0].verification }));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Demo failed"); process.exitCode = 1; });
