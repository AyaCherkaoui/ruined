import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../lib/db";
import { initializeAggregate } from "../lib/pipeline/aggregate-store";
import { aggregateCoverageChanges } from "../lib/pipeline/coverage-alert-source";
import { runDemo } from "../lib/pipeline/demo";

async function main() {
  const { values } = parseArgs({ options: {
    stage: { type: "string", default: "adverse" },
    output: { type: "string", default: process.env.COVERAGE_ALERTS_PAYLOAD || "data/raw/coverage-alerts.json" },
  } });
  if (!["baseline", "adverse", "restored"].includes(values.stage!)) throw new Error("stage must be baseline, adverse, or restored");
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "coverage-demo-"));
  const db = await openDb({ path: ":memory:" });
  const output = path.resolve(values.output!);
  const pending = `${output}.${process.pid}.tmp`;
  try {
    await initializeAggregate(db);
    const proof = await runDemo(db, temporary);
    const payload = values.stage === "restored" ? proof.finalPayload : values.stage === "baseline"
      ? { ...proof.adversePayload, observations: proof.adversePayload.observations.filter((o) => o.sourceRunId === "demo-baseline"), changes: [], doctorImpacts: [] }
      : proof.adversePayload;
    const alerts = aggregateCoverageChanges(payload);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(pending, JSON.stringify(payload, null, 2) + "\n", { flag: "wx" });
    await fs.rename(pending, output);
    console.log(JSON.stringify({ stage: values.stage, output, alerts: alerts.length, simulated: values.stage !== "baseline", externalMessagesSent: 0 }));
  } finally {
    await db.close();
    await fs.rm(pending, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Demo preparation failed"); process.exitCode = 1; });
