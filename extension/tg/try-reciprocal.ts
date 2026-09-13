// One-off: mutual-trust bonus beta sweep vs a fan sybil farm.
//   npx tsx extension/tg/try-reciprocal.ts
//
// Mutual edge weight = w * (1 + beta). beta=0 -> off, beta=Inf -> hard filter
// (drop edges with no reverse). Measures farm suppression vs honest signal.

import { computePpr } from "./ppr.js";
import {
  DEFAULT_SIM,
  generateScenario,
  injectSybilFarm,
  toAdjacency,
  sellersOf as sellers,
  reputationSeparation as separation,
  type EdgeRecord,
} from "./sim.js";
import { agg, auc, fmt, rankOf } from "./metrics.js";

const SEEDS = Number(process.env.TG_SEEDS ?? 10);
const SIZE = 300;
const ALPHA = 0.8;

function applyMutual(edges: EdgeRecord[], beta: number): EdgeRecord[] {
  const set = new Set(edges.map((e) => `${e.from}|${e.to}`));
  if (beta === Infinity) return edges.filter((e) => set.has(`${e.to}|${e.from}`));
  if (beta === 0) return edges;
  return edges.map((e) => (set.has(`${e.to}|${e.from}`) ? { ...e, weight: e.weight * (1 + beta) } : e));
}

interface Row {
  before: number;
  after: number;
  mult: number;
  share: number;
  sep: number;
  auc: number;
}

function runVariant(seed: number, beta: number): Row | null {
  const scn = generateScenario({ ...DEFAULT_SIM, seed });
  const now = scn.config.ticks;
  // Pick bridge/target on the plain graph, so selection is identical across betas.
  const plain = computePpr(toAdjacency(scn.edges), scn.root, { alpha: ALPHA });
  const ranked = sellers(scn.users).filter((u) => (plain.get(u.id) ?? 0) > 0).sort((a, b) => (plain.get(b.id) ?? 0) - (plain.get(a.id) ?? 0));
  if (ranked.length < 6) return null;
  const bridge = ranked[0]!.id;
  const target = ranked[Math.floor(ranked.length / 2)]!.id;

  const { edges: atkEdges, sybils: atkUsers } = injectSybilFarm(scn.edges, scn.users, { bridge, target, size: SIZE, entry: "fan", tick: now });

  const base = computePpr(toAdjacency(applyMutual(scn.edges, beta)), scn.root, { alpha: ALPHA });
  const atk = computePpr(toAdjacency(applyMutual(atkEdges, beta)), scn.root, { alpha: ALPHA });

  const before = rankOf(base).get(target) ?? base.size;
  const after = rankOf(atk).get(target) ?? atk.size;
  const s0 = base.get(target) ?? 0;
  const s1 = atk.get(target) ?? 0;
  const sybilIds = atkUsers.filter((u) => u.id.startsWith("sybil")).map((u) => u.id);
  const total = [...atk.values()].reduce((a, b) => a + b, 0);
  const sybilSum = sybilIds.reduce((a, id) => a + (atk.get(id) ?? 0), 0);
  const honest = sellers(scn.users).map((u) => atk.get(u.id) ?? 0).filter((s) => s > 0);
  const sybilScores = sybilIds.map((id) => atk.get(id) ?? 0);
  return {
    before,
    after,
    mult: s0 > 0 ? s1 / s0 : 0,
    share: total > 0 ? sybilSum / total : 0,
    sep: separation(atk, scn.users),
    auc: auc(sybilScores, honest),
  };
}

function main(): void {
  console.log(`mutual bonus sweep | seeds=${SEEDS} farm size=${SIZE} fan entry`);
  console.log("beta   target-rank before→after   score-mult    sybil-share   separation   AUC");
  const betas: Array<[string, number]> = [["0 (off)", 0], ["0.5", 0.5], ["1.0", 1], ["2.0", 2], ["hard", Infinity]];
  for (const [name, beta] of betas) {
    const rows: Row[] = [];
    for (let s = 1; s <= SEEDS; s++) {
      const r = runVariant(s, beta);
      if (r) rows.push(r);
    }
    const before = fmt(agg(rows.map((r) => r.before)), 0);
    const after = fmt(agg(rows.map((r) => r.after)), 0);
    console.log(
      `${name.padEnd(7)} ${before.padStart(9)} → ${after.padStart(9)}   ${fmt(agg(rows.map((r) => r.mult)), 1).padStart(9)}   ${fmt(agg(rows.map((r) => r.share)), 4).padStart(9)}   ${fmt(agg(rows.map((r) => r.sep)), 2).padStart(8)}   ${fmt(agg(rows.map((r) => r.auc)), 2).padStart(6)}`,
    );
  }
}

main();
