// Pilot report: summarize a telemetry JSONL file.
//   npx tsx extension/tg/telemetry-report.ts path/to/telemetry.jsonl

import { readTelemetryJsonl } from "./telemetry-node.js";
import { summarizeTelemetry, formatSummary } from "./telemetry.js";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npx tsx extension/tg/telemetry-report.ts <telemetry.jsonl>");
    process.exit(1);
  }
  const events = await readTelemetryJsonl(path);
  console.log(`${events.length} events from ${path}\n`);
  console.log(formatSummary(summarizeTelemetry(events)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
