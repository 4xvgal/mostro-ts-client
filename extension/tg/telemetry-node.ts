// Node JSONL telemetry sink + reader. Import only in Node/Bun.

import { appendFile, readFile } from "node:fs/promises";
import type { TelemetryEvent, TelemetrySink } from "./telemetry.js";

/** Append one JSON line per event. Fire-and-forget; failures are ignored. */
export class JsonlTelemetrySink implements TelemetrySink {
  constructor(private readonly path: string) {}

  emit(event: TelemetryEvent): void {
    void appendFile(this.path, JSON.stringify(event) + "\n").catch(() => {});
  }
}

export async function readTelemetryJsonl(path: string): Promise<TelemetryEvent[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as TelemetryEvent);
  } catch {
    return [];
  }
}
