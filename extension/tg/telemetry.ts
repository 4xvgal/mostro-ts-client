// Pilot telemetry: anonymous, aggregate-only evaluation data. No identities,
// order ids, or nonces — just counts, badges, and latencies.
//
// Wire an optional `TelemetrySink` into TrustGraph / annotateOrders; persist
// with JsonlTelemetrySink (telemetry-node.ts) and summarize with the report.

export type TelemetryEvent =
  | RefreshEvent
  | OrderEvent
  | FirstSeenEvent
  | PublishEvent
  | AnnotateEvent
  | SeedEvent;

export interface RefreshEvent {
  ev: "refresh";
  ts: number;
  nodes: number;
  edges: number;
  truncated: boolean;
  ms: number;
  relaysQueried: number;
  hintedNodes: number;
}

export interface OrderEvent {
  ev: "order";
  ts: number;
}

export interface FirstSeenEvent {
  ev: "firstSeen";
  ts: number;
  verdict: "valid" | "invalid";
}

export interface PublishEvent {
  ev: "publish";
  ts: number;
  op: "attest" | "revoke";
  relayOk: number;
  relayFail: number;
}

export interface AnnotateEvent {
  ev: "annotate";
  ts: number;
  state: string;
  resolved: boolean;
  ratingCount: number;
  score: number | null;
  percentile: number | null;
  flags: string[];
}

export interface SeedEvent {
  ev: "seed";
  ts: number;
  count: number;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}

/** In-memory sink (tests, or read in-process). */
export class MemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

export const noopTelemetry: TelemetrySink = { emit: () => {} };

export interface TelemetrySummary {
  refreshCount: number;
  annotateCount: number;
  badgeDistribution: Record<string, number>;
  /** Fraction of annotated orders whose identity verified. */
  resolveRate: number;
  /** Fraction of annotated orders carrying any risk flag. */
  flagRate: number;
  firstSeen: { valid: number; invalid: number };
  publish: { relayOk: number; relayFail: number };
  latencyMs: { p50: number; p95: number; max: number };
  graph: { avgNodes: number; avgEdges: number; truncatedRate: number };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export function summarizeTelemetry(events: TelemetryEvent[]): TelemetrySummary {
  const refresh = events.filter((e): e is RefreshEvent => e.ev === "refresh");
  const annotate = events.filter((e): e is AnnotateEvent => e.ev === "annotate");
  const firstSeen = events.filter((e): e is FirstSeenEvent => e.ev === "firstSeen");
  const publish = events.filter((e): e is PublishEvent => e.ev === "publish");

  const badgeDistribution: Record<string, number> = {};
  let resolved = 0;
  let flagged = 0;
  for (const a of annotate) {
    badgeDistribution[a.state] = (badgeDistribution[a.state] ?? 0) + 1;
    if (a.resolved) resolved++;
    if (a.flags.length > 0) flagged++;
  }

  const lat = refresh.map((e) => e.ms).sort((a, b) => a - b);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  return {
    refreshCount: refresh.length,
    annotateCount: annotate.length,
    badgeDistribution,
    resolveRate: annotate.length ? resolved / annotate.length : 0,
    flagRate: annotate.length ? flagged / annotate.length : 0,
    firstSeen: {
      valid: firstSeen.filter((e) => e.verdict === "valid").length,
      invalid: firstSeen.filter((e) => e.verdict === "invalid").length,
    },
    publish: {
      relayOk: sum(publish.map((e) => e.relayOk)),
      relayFail: sum(publish.map((e) => e.relayFail)),
    },
    latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), max: lat.at(-1) ?? 0 },
    graph: {
      avgNodes: refresh.length ? sum(refresh.map((e) => e.nodes)) / refresh.length : 0,
      avgEdges: refresh.length ? sum(refresh.map((e) => e.edges)) / refresh.length : 0,
      truncatedRate: refresh.length ? refresh.filter((e) => e.truncated).length / refresh.length : 0,
    },
  };
}

export function formatSummary(s: TelemetrySummary): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const badges = Object.entries(s.badgeDistribution)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ") || "(none)";
  return [
    `refresh=${s.refreshCount}  graph avg nodes=${s.graph.avgNodes.toFixed(0)} edges=${s.graph.avgEdges.toFixed(0)} truncated=${pct(s.graph.truncatedRate)}`,
    `latency p50=${s.latencyMs.p50}ms p95=${s.latencyMs.p95}ms max=${s.latencyMs.max}ms`,
    `annotate=${s.annotateCount}  resolve=${pct(s.resolveRate)}  flag=${pct(s.flagRate)}`,
    `badges: ${badges}`,
    `firstSeen: valid=${s.firstSeen.valid} invalid=${s.firstSeen.invalid}`,
    `publish: relayOk=${s.publish.relayOk} relayFail=${s.publish.relayFail}`,
  ].join("\n");
}
