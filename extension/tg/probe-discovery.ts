// Public-network discovery verdict: fixed relay set vs declared-relay routing.
//
// Real kind 30500 doesn't exist yet, so NIP-65 (kind 10002, the only existing
// self-declaration) is the proxy. Measures whether routing each author through
// the write relays THEY declare recovers what a fixed 3-relay set misses, and
// at what cost.
//
//   TG_SEEDS=200 npx tsx extension/tg/probe-discovery.ts
//
// Read-only. Env: TG_RELAYS (csv), TG_SEEDS, TG_CONC, TG_HINT_CAP (0 = no cap).

import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";

const FIXED = (process.env.TG_RELAYS ?? "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net").split(",");
const N = Number(process.env.TG_SEEDS ?? 200);
const CONC = Number(process.env.TG_CONC ?? 20);
const HINT_CAP = Number(process.env.TG_HINT_CAP ?? 0); // 0 = query all declared relays
const CHUNK = 100;
const HINT_TIMEOUT = Number(process.env.TG_HINT_TIMEOUT ?? 4_000);

const KIND_META = 0;
const KIND_FOLLOW = 3;
const KIND_RELAYLIST = 10002;

const pool = new SimplePool();
const usedRelays = new Set<string>(FIXED);
let queries = 0;
let bytes = 0;
let timeouts = 0;

async function query(relay: string, filter: Filter, maxWait = 12_000): Promise<NostrEvent[]> {
  queries++;
  usedRelays.add(relay);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hard = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("hard-timeout")), maxWait + 3_000);
    });
    const events = await Promise.race([pool.querySync([relay], filter, { maxWait }), hard]);
    for (const e of events) bytes += JSON.stringify(e).length;
    return events;
  } catch {
    timeouts++;
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function writeRelaysFrom(ev: NostrEvent): string[] {
  const out: string[] = [];
  for (const t of ev.tags) {
    if (t[0] !== "r" || !t[1]) continue;
    if (t[2] === "read") continue; // write or unmarked
    if (t[1].startsWith("wss://") || t[1].startsWith("ws://")) out.push(t[1]);
  }
  return out;
}

function pct(n: number, d: number): string {
  return `${n}/${d} (${((100 * n) / Math.max(1, d)).toFixed(1)}%)`;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function main() {
  const t0 = performance.now();
  console.log(`fixed relays: ${FIXED.join(", ")}  N=${N} conc=${CONC}`);

  // ---- seeds from recent kind-1 ----
  const seeds = new Set<string>();
  for (const relay of FIXED) {
    const evs = await query(relay, { kinds: [1], limit: 500 });
    for (const e of evs) seeds.add(e.pubkey);
  }
  const seedList = [...seeds].slice(0, N);
  console.log(`seeds=${seedList.length}\n`);

  // ---- fixed-3 presence: kind-0 / kind-3 / kind-10002 (+ parse write relays) ----
  const hasMeta = new Set<string>();
  const hasFollow = new Set<string>();
  const declared = new Map<string, string[]>(); // author -> write relays
  for (const chunk of chunks(seedList, CHUNK)) {
    for (const relay of FIXED) {
      for (const e of await query(relay, { kinds: [KIND_META], authors: chunk })) hasMeta.add(e.pubkey);
      for (const e of await query(relay, { kinds: [KIND_FOLLOW], authors: chunk })) hasFollow.add(e.pubkey);
      for (const e of await query(relay, { kinds: [KIND_RELAYLIST], authors: chunk })) {
        const w = writeRelaysFrom(e);
        if (w.length) declared.set(e.pubkey, [...new Set([...(declared.get(e.pubkey) ?? []), ...w])]);
      }
    }
  }

  // ---- declared-relay routing (all write relays, no cap by default) ----
  const groups = new Map<string, Set<string>>();
  for (const pk of seedList) {
    for (const r of declared.get(pk) ?? []) {
      if (FIXED.includes(r)) continue;
      const s = groups.get(r) ?? new Set<string>();
      s.add(pk);
      groups.set(r, s);
    }
  }
  const allHintRelays = [...groups.keys()];
  const hintRelays = HINT_CAP > 0 ? allHintRelays.slice(0, HINT_CAP) : allHintRelays;
  console.log(`[routing] declared hint relays=${allHintRelays.length}, querying=${hintRelays.length} (cap ${HINT_CAP || "none"})`);

  let liveHintRelays = 0;
  const followViaHints = new Set<string>();
  await mapPool(hintRelays, CONC, async (relay) => {
    const authors = [...groups.get(relay)!];
    let any = false;
    for (const chunk of chunks(authors, CHUNK)) {
      const evs = await query(relay, { kinds: [KIND_FOLLOW], authors: chunk }, HINT_TIMEOUT);
      for (const e of evs) {
        followViaHints.add(e.pubkey);
        any = true;
      }
    }
    if (any) liveHintRelays++;
  });

  const routedFollow = new Set([...hasFollow, ...followViaHints]);
  const recovered = [...followViaHints].filter((p) => !hasFollow.has(p));
  const seedSet = new Set(seedList);
  const routeable = [...declared.keys()].filter((p) => seedSet.has(p));
  const gap = routeable.filter((p) => !hasFollow.has(p)); // candidates routing could fix

  // ---- report ----
  console.log("\n=== FIXED-3 COVERAGE (over seeds) ===");
  console.log(`kind-0     ${pct(hasMeta.size, seedList.length)}`);
  console.log(`kind-3     ${pct(hasFollow.size, seedList.length)}`);
  console.log(`kind-10002 ${pct(declared.size, seedList.length)}   (authors we can route)`);
  const metaNoFollow = [...hasMeta].filter((p) => !hasFollow.has(p)).length;
  console.log(`kind-0 present but kind-3 missing: ${pct(metaNoFollow, hasMeta.size)}`);

  const hintsPerAuthor = [...declared.values()].map((r) => r.length);
  console.log("\n=== DECLARED-RELAY ROUTING ===");
  console.log(`hint relays: total=${allHintRelays.length} queried=${hintRelays.length} live(returned kind-3)=${liveHintRelays}`);
  console.log(`hints per author: median=${median(hintsPerAuthor)} max=${Math.max(0, ...hintsPerAuthor)}`);
  console.log(`kind-3 recovered only via hints: ${recovered.length}`);
  console.log(`candidates (routeable but no fixed kind-3): ${gap.length} -> recovered via hints: ${recovered.length}/${gap.length}`);
  console.log(`coverage kind-3: fixed=${pct(hasFollow.size, seedList.length)} -> fixed+routed=${pct(routedFollow.size, seedList.length)}  (+${((100 * (routedFollow.size - hasFollow.size)) / seedList.length).toFixed(1)}%p)`);

  const wall = (performance.now() - t0) / 1000;
  console.log("\n=== COST ===");
  console.log(`wall=${wall.toFixed(1)}s queries=${queries} events-bytes=${(bytes / 1e6).toFixed(1)}MB timeouts=${timeouts}`);

  pool.close([...usedRelays]);
  console.log(
    `\nVERDICT: ${recovered.length > 0 ? "declared routing recovers" : "declared routing recovers NOTHING"} ` +
      `(routeable authors ${declared.size}/${seedList.length})`,
  );
}

main().catch((e) => {
  console.error("probe FAIL:", e);
  process.exit(1);
});
