// One-off: does the rating-vs-PPR discordance flag catch a farmed target?
//   npx tsx extension/tg/try-flag.ts
//
// Ground truth is known (injected target/sybils). Flag if
// discordance = pprPct - ratingPct > theta.  Reports AUC(target vs honest)
// and a theta sweep (target hit, sybil hit, honest false-positive).

import { computePpr } from "./ppr.js";
import { DEFAULT_SIM, generateScenario, injectSybilFarm, toAdjacency, sellersOf, type SimUser } from "./sim.js";
import { agg, fmt } from "./metrics.js";

const SEEDS = Number(process.env.TG_SEEDS ?? 10);
const ALPHA = 0.8;
const THETAS = [-0.1, 0, 0.1, 0.2, 0.3, 0.5, 0.7];

function pctBelow(values: number[], v: number): number {
  if (values.length < 2) return 0;
  let below = 0;
  for (const x of values) if (x < v) below++;
  return below / (values.length - 1);
}

interface SeedResult {
  targetDisc: number;
  honestDisc: number[];
  sybilDisc: number[];
  pprOnlyTargetHit: boolean;
  pprOnlyHonestFp: number;
}

function runSeed(seed: number, size: number): SeedResult | null {
  const scn = generateScenario({ ...DEFAULT_SIM, seed });
  const now = scn.config.ticks;
  const plain = computePpr(toAdjacency(scn.edges), scn.root, { alpha: ALPHA });
  const sellers = sellersOf(scn.users);
  const ranked = sellers.filter((u) => (plain.get(u.id) ?? 0) > 0).sort((a, b) => (plain.get(b.id) ?? 0) - (plain.get(a.id) ?? 0));
  if (ranked.length < 6) return null;
  const bridge = ranked[0]!.id;
  const target = ranked[Math.floor(ranked.length / 2)]!;

  const { edges, sybils } = injectSybilFarm(scn.edges, scn.users, { bridge, target: target.id, size, entry: "fan", tick: now });
  const atk = computePpr(toAdjacency(edges), scn.root, { alpha: ALPHA });

  const sybilIds = sybils.filter((u) => u.id.startsWith("sybil")).map((u) => u.id);
  const pool: Array<{ id: string; rating: number; ppr: number }> = [
    ...sellers.map((u: SimUser) => ({ id: u.id, rating: u.reputation, ppr: atk.get(u.id) ?? 0 })),
    ...sybilIds.map((id) => ({ id, rating: 0, ppr: atk.get(id) ?? 0 })),
  ];
  const ratings = pool.map((p) => p.rating);
  const pprs = pool.map((p) => p.ppr);
  const disc = (p: { rating: number; ppr: number }) => pctBelow(pprs, p.ppr) - pctBelow(ratings, p.rating);

  const targetP = pool.find((p) => p.id === target.id)!;
  const honest = pool.filter((p) => p.id !== target.id && !p.id.startsWith("sybil"));
  const sybilP = pool.filter((p) => p.id.startsWith("sybil"));
  const targetDisc = disc(targetP);
  const highPpr = (p: { ppr: number }) => pctBelow(pprs, p.ppr) > 0.9;
  return {
    targetDisc,
    honestDisc: honest.map(disc),
    sybilDisc: sybilP.map(disc),
    pprOnlyTargetHit: highPpr(targetP),
    pprOnlyHonestFp: honest.length ? honest.filter(highPpr).length / honest.length : 0,
  };
}

function main(): void {
  for (const size of [10, 100]) {
    const rows: SeedResult[] = [];
    for (let s = 1; s <= SEEDS; s++) {
      const r = runSeed(s, size);
      if (r) rows.push(r);
    }
    // AUC: fraction of honest below the target's discordance.
    const aucs = rows.map((r) => r.honestDisc.filter((d) => d < r.targetDisc).length / r.honestDisc.length);
    console.log(`\n=== farm size=${size} (seeds=${rows.length}) ===`);
    console.log(`AUC(discordance: target > honest) = ${fmt(agg(aucs), 3)}   (0.5 = no signal, 1.0 = perfect)`);
    const pprOnly = rows.filter((r) => r.pprOnlyTargetHit).length / rows.length;
    const pprOnlyFp = rows.reduce((a, r) => a + r.pprOnlyHonestFp, 0) / rows.length;
    console.log(`PPR-only rule (top-10% PPR): target hit = ${pprOnly.toFixed(2)}, honest-FP = ${pprOnlyFp.toFixed(3)}`);
    console.log("theta   target-hit   sybil-hit   honest-FP");
    for (const th of THETAS) {
      const targetHit = rows.filter((r) => r.targetDisc > th).length / rows.length;
      const sybilHit = rows.reduce((a, r) => a + (r.sybilDisc.length ? r.sybilDisc.filter((d) => d > th).length / r.sybilDisc.length : 0), 0) / rows.length;
      const fp = rows.reduce((a, r) => a + r.honestDisc.filter((d) => d > th).length / r.honestDisc.length, 0) / rows.length;
      console.log(`${String(th).padEnd(6)}  ${targetHit.toFixed(2)}         ${sybilHit.toFixed(3)}       ${fp.toFixed(3)}`);
    }
  }
}

main();
