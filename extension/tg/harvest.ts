// L2 topology harvest: NIP-02 follow graph over public relays.
// Measures out-degree, per-hop reach, relay coverage, NIP-65 existence, and the
// network/compute/time cost of building the graph. Follow graph != trust graph:
// topology prior only (no weights, no trust direction).
//
//   TG_SEEDS=1000 npx tsx extension/tg/harvest.ts
//
// Env: TG_RELAYS (csv), TG_SEEDS, TG_WAVE1 (hop-1 followee sample), TG_NIP65.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";

const RELAYS = (process.env.TG_RELAYS ?? "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net").split(",");
const N_SEEDS = Number(process.env.TG_SEEDS ?? 1000);
const N_WAVE1 = Number(process.env.TG_WAVE1 ?? 500);
const N_NIP65 = Number(process.env.TG_NIP65 ?? 200);
const CHUNK = 100;
const KIND_FOLLOW = 3;
const KIND_RELAYLIST = 10002;

interface RelayStat {
  queries: number;
  events: number;
  bytes: number;
  ms: number;
  timeouts: number;
}

const stats = new Map<string, RelayStat>();
function stat(relay: string): RelayStat {
  let s = stats.get(relay);
  if (!s) {
    s = { queries: 0, events: 0, bytes: 0, ms: 0, timeouts: 0 };
    stats.set(relay, s);
  }
  return s;
}

function totals() {
  let queries = 0, events = 0, bytes = 0, ms = 0;
  for (const s of stats.values()) {
    queries += s.queries;
    events += s.events;
    bytes += s.bytes;
    ms += s.ms;
  }
  return { queries, events, bytes, ms };
}

const phases: Array<{ name: string; ms: number; delta: ReturnType<typeof totals> }> = [];
function markPhase(name: string, startedAt: number, before: ReturnType<typeof totals>): void {
  const now = totals();
  phases.push({
    name,
    ms: performance.now() - startedAt,
    delta: {
      queries: now.queries - before.queries,
      events: now.events - before.events,
      bytes: now.bytes - before.bytes,
      ms: now.ms - before.ms,
    },
  });
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function queryRelay(pool: SimplePool, relay: string, filter: Filter): Promise<NostrEvent[]> {
  const s = stat(relay);
  const t0 = performance.now();
  try {
    const events = await pool.querySync([relay], filter, { maxWait: 15_000 });
    s.queries++;
    s.events += events.length;
    s.ms += performance.now() - t0;
    for (const e of events) s.bytes += JSON.stringify(e).length;
    return events;
  } catch {
    s.queries++;
    s.timeouts++;
    s.ms += performance.now() - t0;
    return [];
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function fetchFollowLists(
  pool: SimplePool,
  authors: string[],
): Promise<{ follows: Map<string, string[]>; coverage: Map<string, Set<string>> }> {
  const follows = new Map<string, string[]>();
  const seenAt = new Map<string, number>();
  const coverage = new Map<string, Set<string>>(RELAYS.map((r) => [r, new Set<string>()]));
  for (const chunk of chunks(authors, CHUNK)) {
    for (const relay of RELAYS) {
      const events = await queryRelay(pool, relay, { kinds: [KIND_FOLLOW], authors: chunk });
      const cov = coverage.get(relay)!;
      for (const e of events) {
        cov.add(e.pubkey);
        if ((seenAt.get(e.pubkey) ?? -1) >= e.created_at) continue;
        seenAt.set(e.pubkey, e.created_at);
        follows.set(e.pubkey, e.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]!));
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return { follows, coverage };
}

async function main() {
  const pool = new SimplePool();
  const tStart = performance.now();
  console.log(`relays: ${RELAYS.join(", ")}`);

  // ---- Phase 1: seed authors from recent kind-1, paginated on `until` ----
  console.log(`[1] harvesting ${N_SEEDS} seed pubkeys from recent kind-1...`);
  let tPhase = performance.now();
  let before = totals();
  const seeds = new Set<string>();
  let until: number | undefined;
  for (let page = 0; page < 20 && seeds.size < N_SEEDS; page++) {
    let oldest = Math.floor(Date.now() / 1000);
    let got = false;
    for (const relay of RELAYS) {
      const filter: Filter = { kinds: [1], limit: 500 };
      if (until !== undefined) filter.until = until;
      const events = await queryRelay(pool, relay, filter);
      for (const e of events) {
        seeds.add(e.pubkey);
        oldest = Math.min(oldest, e.created_at);
        got = true;
      }
    }
    if (!got) break;
    until = oldest - 1;
  }
  const seedList = [...seeds].slice(0, N_SEEDS);
  markPhase("seed kind-1", tPhase, before);
  console.log(`    got ${seedList.length} seeds`);
  if (seedList.length < 10) throw new Error("too few seeds — relay seed query failed");

  // ---- Phase 2: follow lists (hop-1) ----
  console.log(`[2] fetching kind-3 follow lists for ${seedList.length} seeds...`);
  tPhase = performance.now();
  before = totals();
  const { follows: follow1, coverage } = await fetchFollowLists(pool, seedList);
  markPhase("follow lists (hop-1)", tPhase, before);

  // ---- Phase 3: wave-1 sample (enables hop-2 reach) ----
  const hop1 = new Set<string>();
  for (const list of follow1.values()) for (const p of list) hop1.add(p);
  const hop1Sample = [...hop1].filter((p) => !seeds.has(p)).slice(0, N_WAVE1);
  console.log(`[3] fetching kind-3 for ${hop1Sample.length} hop-1 followees (wave 2)...`);
  tPhase = performance.now();
  before = totals();
  const { follows: follow2 } = await fetchFollowLists(pool, hop1Sample);
  markPhase("follow lists (wave 2)", tPhase, before);

  // ---- Build digraph ----
  const tBuild = performance.now();
  const graph = new Map<string, string[]>();
  const edgeSet = new Set<string>();
  for (const [a, list] of [...follow1, ...follow2]) {
    const uniq = [...new Set(list)];
    graph.set(a, uniq);
    for (const b of uniq) edgeSet.add(`${a}\n${b}`);
  }
  const nodes = new Set<string>();
  for (const [a, list] of graph) {
    nodes.add(a);
    for (const b of list) nodes.add(b);
  }

  // ---- Out-degree distribution (over seeds only — bias: recent kind-1 authors) ----
  const outDegrees = seedList.map((p) => follow1.get(p)?.length ?? 0);
  const reached = outDegrees.filter((d) => d > 0).length;

  // ---- Hop reach from sampled roots ----
  const rootCount = Math.min(50, seedList.length);
  const roots = seedList.slice(0, rootCount);
  const hopNew = [0, 0, 0, 0];
  const hopCum = [0, 0, 0, 0];
  for (const root of roots) {
    const seen = new Set<string>([root]);
    let frontier = [root];
    for (let h = 0; h < 4; h++) {
      const next: string[] = [];
      for (const u of frontier) {
        for (const v of graph.get(u) ?? []) {
          if (!seen.has(v)) {
            seen.add(v);
            next.push(v);
          }
        }
      }
      hopNew[h] = (hopNew[h] ?? 0) + next.length;
      hopCum[h] = (hopCum[h] ?? 0) + (seen.size - 1);
      frontier = next;
      if (frontier.length === 0) break;
    }
  }
  const buildMs = performance.now() - tBuild;
  const heapMB = process.memoryUsage().heapUsed / 1e6;
  const avgNew = hopNew.map((n) => n / rootCount);
  const avgCum = hopCum.map((n) => n / rootCount);

  // ---- NIP-65 existence over a subsample ----
  console.log(`[4] NIP-65 (kind 10002) existence over ${N_NIP65} seeds...`);
  tPhase = performance.now();
  before = totals();
  const nip65Sample = seedList.slice(0, Math.min(N_NIP65, seedList.length));
  const nip65Has = new Set<string>();
  for (const chunk of chunks(nip65Sample, CHUNK)) {
    for (const relay of RELAYS) {
      const evs = await queryRelay(pool, relay, { kinds: [KIND_RELAYLIST], authors: chunk });
      for (const e of evs) nip65Has.add(e.pubkey);
    }
  }
  markPhase("NIP-65 probe", tPhase, before);

  const wallMs = performance.now() - tStart;
  const total = totals();

  // ---- Report ----
  console.log("\n=== TOPOLOGY ===");
  console.log(`seeds=${seedList.length}  nodes=${nodes.size}  edges=${edgeSet.size}  heap=${heapMB.toFixed(0)}MB  build=${buildMs.toFixed(0)}ms`);
  console.log(`seed out-degree: mean=${(outDegrees.reduce((a, b) => a + b, 0) / outDegrees.length).toFixed(1)} median=${median(outDegrees)} p95=${percentile(outDegrees, 95)} p99=${percentile(outDegrees, 99)} max=${Math.max(...outDegrees)}`);
  console.log(`seeds with follow list (union)=${reached}/${seedList.length} (${((100 * reached) / seedList.length).toFixed(1)}%)`);
  console.log(`avg reach from root: hop1=${avgNew[0]!.toFixed(0)} hop2=+${avgNew[1]!.toFixed(0)} hop3=+${avgNew[2]!.toFixed(0)} hop4=+${avgNew[3]!.toFixed(0)}  (cum ${avgCum.map((c) => c.toFixed(0)).join(" / ")})`);
  console.log(`NIP-65 present=${nip65Has.size}/${nip65Sample.length} (${((100 * nip65Has.size) / nip65Sample.length).toFixed(1)}%)`);

  console.log("\n=== PER-RELAY kind-3 COVERAGE (of seed set) ===");
  const unionCov = new Set<string>();
  for (const set of coverage.values()) for (const p of set) unionCov.add(p);
  for (const relay of RELAYS) {
    const cov = coverage.get(relay)!;
    console.log(`${relay.padEnd(28)} cover=${cov.size}/${seedList.length} (${((100 * cov.size) / seedList.length).toFixed(1)}%)`);
  }
  console.log(`union=${unionCov.size}/${seedList.length} (${((100 * unionCov.size) / seedList.length).toFixed(1)}%)`);

  console.log("\n=== PER-RELAY NETWORK ===");
  for (const relay of RELAYS) {
    const s = stat(relay);
    console.log(`${relay.padEnd(28)} q=${String(s.queries).padStart(3)} ev=${String(s.events).padStart(6)} bytes=${(s.bytes / 1e6).toFixed(1)}MB time=${(s.ms / 1000).toFixed(1)}s timeouts=${s.timeouts}`);
  }

  console.log("\n=== PHASE COST ===");
  for (const p of phases) {
    console.log(`${p.name.padEnd(22)} wall=${(p.ms / 1000).toFixed(1)}s q=${p.delta.queries} ev=${p.delta.events} json=${(p.delta.bytes / 1e6).toFixed(1)}MB relay=${(p.delta.ms / 1000).toFixed(1)}s`);
  }

  console.log("\n=== TOTAL COST ===");
  console.log(`wall=${(wallMs / 1000).toFixed(1)}s  queries=${total.queries}  events=${total.events}  jsonBytes=${(total.bytes / 1e6).toFixed(1)}MB`);
  console.log(`wire estimate (json * 1.3): ${((total.bytes * 1.3) / 1e6).toFixed(1)}MB`);
  console.log(`throughput: ${(total.events / (wallMs / 1000)).toFixed(0)} ev/s, ${(total.bytes / (wallMs / 1000) / 1e3).toFixed(0)} KB/s`);

  // ---- Save indexed graph for the L1 sweep ----
  const nodeList = [...nodes];
  const nodeIndex = new Map(nodeList.map((n, i) => [n, i]));
  const indexedEdges: Array<[number, number]> = [];
  for (const e of edgeSet) {
    const [a, b] = e.split("\n") as [string, string];
    indexedEdges.push([nodeIndex.get(a)!, nodeIndex.get(b)!]);
  }
  const OUT = fileURLToPath(new URL("./out/follow-graph.json", import.meta.url));
  mkdirSync(fileURLToPath(new URL("./out/", import.meta.url)), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      relays: RELAYS,
      seeds: seedList.length,
      nodes: nodeList,
      edges: indexedEdges,
      outDegree: { mean: outDegrees.reduce((a, b) => a + b, 0) / outDegrees.length, median: median(outDegrees), p95: percentile(outDegrees, 95), p99: percentile(outDegrees, 99), max: Math.max(...outDegrees) },
      hopReach: { avgNew, avgCum },
      kind3Coverage: Object.fromEntries([...coverage].map(([r, s]) => [r, s.size / seedList.length])),
      nip65Rate: nip65Has.size / nip65Sample.length,
    }),
  );
  console.log(`\nsaved -> ${OUT}`);
  pool.close(RELAYS);
}

main().catch((e) => {
  console.error("harvest FAIL:", e);
  process.exit(1);
});
