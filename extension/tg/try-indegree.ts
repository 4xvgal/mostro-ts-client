// One-off: in-degree normalized PPR vs a fan sybil farm.
//   npx tsx extension/tg/try-indegree.ts
//
// final(v) = ppr(v) / (D_in(v) + 1)^k      D_in uses decayed edge weights.
// Compares k in {0,1,2} and decay in {1.0, 0.95}. Not wired into redteam.ts.

import { computePpr } from "./ppr.js";
import {
  DEFAULT_SIM,
  generateScenario,
  injectSybilFarm,
  toAdjacency,
  sellersOf as sellers,
  reputationSeparation as separation,
  type EdgeRecord,
  type Scenario,
} from "./sim.js";
import { agg, auc, fmt, rankOf } from "./metrics.js";

const SEEDS = Number(process.env.TG_SEEDS ?? 10);
const SIZE = 300;
const ALPHA = 0.8;

function inDegree(edges: EdgeRecord[], now: number, decay: number): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of edges) {
    const w = decay === 1 ? e.weight : e.weight * Math.pow(decay, now - e.tick);
    d.set(e.to, (d.get(e.to) ?? 0) + w);
  }
  return d;
}

function normalize(scores: Map<string, number>, edges: EdgeRecord[], k: number, decay: number, now: number): Map<string, number> {
  if (k === 0) return scores;
  const d = inDegree(edges, now, decay);
  const out = new Map<string, number>();
  for (const [n, s] of scores) out.set(n, s / Math.pow((d.get(n) ?? 0) + 1, k));
  return out;
}

interface Row {
  targetBefore: number;
  targetAfter: number;
  mult: number;
  sybilShare: number;
  sep: number;
  auc: number;
}

function runVariant(seed: number, k: number, decay: number): Row | null {
  const scn = generateScenario({ ...DEFAULT_SIM, seed });
  const now = scn.config.ticks;
  const base = computePpr(toAdjacency(scn.edges), scn.root, { alpha: ALPHA });
  const ranked = sellers(scn.users).filter((u) => (base.get(u.id) ?? 0) > 0).sort((a, b) => (base.get(b.id) ?? 0) - (base.get(a.id) ?? 0));
  if (ranked.length < 6) return null;
  const bridge = ranked[0]!.id;
  const target = ranked[Math.floor(ranked.length / 2)]!.id;

  const { edges: atkEdges, sybils: atkUsers } = injectSybilFarm(scn.edges, scn.users, { bridge, target, size: SIZE, entry: "fan", tick: now });
  const atk = computePpr(toAdjacency(atkEdges), scn.root, { alpha: ALPHA });

  const nb = normalize(base, scn.edges, k, decay, now);
  const na = normalize(atk, atkEdges, k, decay, now);

  const before = rankOf(nb).get(target) ?? nb.size;
  const after = rankOf(na).get(target) ?? na.size;
  const s0 = nb.get(target) ?? 0;
  const s1 = na.get(target) ?? 0;
  const sybilIds = atkUsers.filter((u) => u.id.startsWith("sybil")).map((u) => u.id);
  const total = [...na.values()].reduce((a, b) => a + b, 0);
  const sybilSum = sybilIds.reduce((a, id) => a + (na.get(id) ?? 0), 0);
  const honest = sellers(scn.users).map((u) => na.get(u.id) ?? 0).filter((s) => s > 0);
  const sybilScores = sybilIds.map((id) => na.get(id) ?? 0);
  return {
    targetBefore: before,
    targetAfter: after,
    mult: s0 > 0 ? s1 / s0 : 0,
    sybilShare: total > 0 ? sybilSum / total : 0,
    sep: separation(na, scn.users),
    auc: auc(sybilScores, honest),
  };
}

function main(): void {
  console.log(`in-degree normalized PPR | seeds=${SEEDS} farm size=${SIZE} fan entry`);
  console.log("k  decay   target-rank before  after   score-mult   sybil-share   separation   AUC");
  for (const k of [0, 1, 2]) {
    for (const decay of [1.0, 0.95]) {
      const rows: Row[] = [];
      for (let s = 1; s <= SEEDS; s++) {
        const r = runVariant(s, k, decay);
        if (r) rows.push(r);
      }
      const col = (f: (r: Row) => number, d = 1) => fmt(agg(rows.map(f)), d).padStart(9);
      console.log(
        `${k}  ${decay.toFixed(2)}    ${col((r) => r.targetBefore, 0)}  ${fmt(agg(rows.map((r) => r.targetAfter)), 0).padStart(6)}   ${col((r) => r.mult, 1)}   ${col((r) => r.sybilShare, 4)}   ${col((r) => r.sep, 2)}   ${col((r) => r.auc, 2)}`,
      );
    }
  }
}

main();
