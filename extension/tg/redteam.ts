// Red-team + realism test cases over the human-like simulator (sim.ts).
//
//   npx tsx extension/tg/redteam.ts
//
// Reports mean ± 95% CI over seeds. 못믿음 = removal model (w=0 -> no edge).

import { computePpr, type Adjacency } from "./ppr.js";
import {
  DEFAULT_SIM,
  generateScenario,
  injectSybilFarm,
  toAdjacency,
  hopRestrict,
  sellersOf,
  reputationSeparation as repSeparation,
  type AdjacencyFilter,
  type EdgeRecord,
  type Scenario,
  type SimConfig,
} from "./sim.js";
import { agg, auc, fmt, gini, rankOf, topK } from "./metrics.js";

const SEEDS = Number(process.env.TG_SEEDS ?? 10);
const ALPHA = 0.8;

function make(seed: number, overrides: Partial<SimConfig> = {}): Scenario {
  return generateScenario({ ...DEFAULT_SIM, seed, ...overrides });
}

type Defense = "baseline" | "cap100" | "cap300" | "reciprocal" | "hop1" | "hop2" | "sybilrank";

function scoresFor(scn: Scenario, edges: EdgeRecord[], defense: Defense): Map<string, number> {
  let filter: AdjacencyFilter = {};
  if (defense === "cap100") filter = { cap: 100 };
  if (defense === "cap300") filter = { cap: 300 };
  if (defense === "reciprocal") filter = { requireReciprocal: true };
  let adj: Adjacency = toAdjacency(edges, filter);
  if (defense === "hop1") adj = hopRestrict(adj, scn.root, 1);
  if (defense === "hop2") adj = hopRestrict(adj, scn.root, 2);
  const scores = computePpr(adj, scn.root, { alpha: ALPHA });
  if (defense === "sybilrank") {
    const deg = new Map<string, number>();
    for (const [u, es] of adj) deg.set(u, es.length);
    for (const [n, s] of scores) scores.set(n, s / ((deg.get(n) ?? 0) + 1));
  }
  return scores;
}

function pickBridgeTarget(scn: Scenario, scores: Map<string, number>): { bridge: string; target: string } | null {
  const ranked = sellersOf(scn.users)
    .filter((u) => (scores.get(u.id) ?? 0) > 0)
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  if (ranked.length < 6) return null;
  // bridge: a top node the root's network reaches; target: a MEDIAN seller, so
  // there is room for the attack to move its rank (top-2 targets made the old
  // test meaningless).
  const bridge = ranked[0]!.id;
  const target = ranked[Math.floor(ranked.length / 2)]!.id;
  return { bridge, target };
}

interface AttackResult {
  targetBefore: number;
  targetAfter: number;
  targetScoreMult: number;
  sybilSum: number;
  sybilTop20: number;
  sybilAuc: number;
}

function runAttack(scn: Scenario, size: number, entry: "fan" | "anchor", defense: Defense): AttackResult | null {
  const baseScores = scoresFor(scn, scn.edges, defense);
  const bt = pickBridgeTarget(scn, baseScores);
  if (!bt) return null;
  const { edges: atkEdges, sybils: atkUsers } = injectSybilFarm(scn.edges, scn.users, {
    bridge: bt.bridge,
    target: bt.target,
    size,
    entry,
  });
  const atkScores = scoresFor(scn, atkEdges, defense);
  const before = rankOf(baseScores).get(bt.target) ?? baseScores.size;
  const after = rankOf(atkScores).get(bt.target) ?? atkScores.size;
  const s0 = baseScores.get(bt.target) ?? 0;
  const s1 = atkScores.get(bt.target) ?? 0;
  const sybilIds = atkUsers.filter((u) => u.id.startsWith("sybil")).map((u) => u.id);
  const sybilSum = sybilIds.reduce((a, id) => a + (atkScores.get(id) ?? 0), 0);
  const t20 = topK(atkScores, 20);
  const sybilTop20 = sybilIds.filter((id) => t20.has(id)).length;
  const honestScores = sellersOf(scn.users)
    .map((u) => atkScores.get(u.id) ?? 0)
    .filter((s) => s > 0);
  const sybilScores = sybilIds.map((id) => atkScores.get(id) ?? 0);
  return {
    targetBefore: before,
    targetAfter: after,
    targetScoreMult: s0 > 0 ? s1 / s0 : 0,
    sybilSum,
    sybilTop20,
    sybilAuc: auc(sybilScores, honestScores),
  };
}

function runAll<T>(fn: (seed: number) => T | null): T[] {
  const out: T[] = [];
  for (let s = 1; s <= SEEDS; s++) {
    const r = fn(s);
    if (r !== null) out.push(r);
  }
  return out;
}

function stats(xs: number[]) {
  return agg(xs);
}

function main(): void {
  console.log(`human-like sim | seeds=${SEEDS} users=${DEFAULT_SIM.users} trades/tick=${DEFAULT_SIM.tradesPerTick} ticks=${DEFAULT_SIM.ticks}`);

  // ---- TC1 + TC2: honest discrimination & low-activity reach ----
  const tc1 = runAll((s) => {
    const scn = make(s);
    const sc = scoresFor(scn, scn.edges, "baseline");
    const lowRep = sellersOf(scn.users).filter((u) => u.reputation >= 1 && u.reputation <= 3);
    const reachableLow = lowRep.filter((u) => (sc.get(u.id) ?? 0) > 0).length;
    return { sep: repSeparation(sc, scn.users), lowReach: lowRep.length ? reachableLow / lowRep.length : 0, nodes: sc.size };
  });
  console.log("\n=== TC1/TC2 honest graph ===");
  console.log(`top20-rep / all-rep separation: ${fmt(stats(tc1.map((x) => x.sep)))}  (>1 = score tracks reputation)`);
  console.log(`low-activity (rep 1-3) reachable: ${fmt(stats(tc1.map((x) => x.lowReach)))}`);
  console.log(`PPR node count: ${stats(tc1.map((x) => x.nodes)).mean.toFixed(0)}`);

  // ---- TC3: fan-entry sybil size sweep ----
  console.log("\n=== TC3 fan-entry sybil (baseline defense) ===");
  console.log("size   target-rank before  after   score-mult   sybil-sum     sybil-in-top20   AUC(sybil|honest)");
  for (const size of [10, 30, 100, 300]) {
    const rs = runAll((s) => runAttack(make(s), size, "fan", "baseline"));
    console.log(
      `${String(size).padEnd(6)} ${fmt(stats(rs.map((r) => r.targetBefore)), 1).padStart(10)}   ${fmt(stats(rs.map((r) => r.targetAfter)), 1).padStart(8)}   ${fmt(stats(rs.map((r) => r.targetScoreMult)), 2).padStart(8)}   ${fmt(stats(rs.map((r) => r.sybilSum)), 4)}   ${fmt(stats(rs.map((r) => r.sybilTop20)), 1).padStart(8)}       ${fmt(stats(rs.map((r) => r.sybilAuc)))}`,
    );
  }

  // ---- TC4: anchor-entry ----
  {
    const rs = runAll((s) => runAttack(make(s), 300, "anchor", "baseline"));
    console.log("\n=== TC4 anchor-entry, size=300 ===");
    console.log(`target-rank ${fmt(stats(rs.map((r) => r.targetBefore)), 1)} -> ${fmt(stats(rs.map((r) => r.targetAfter)), 1)}   sybil-sum ${fmt(stats(rs.map((r) => r.sybilSum)), 4)}   top20 ${fmt(stats(rs.map((r) => r.sybilTop20)), 1)}`);
  }

  // ---- TC6: defense sweep on the worst attack ----
  console.log("\n=== TC6 defenses vs fan size=300 ===");
  console.log("defense       target-after   score-mult   sybil-sum     sybil-in-top20   AUC");
  for (const d of ["baseline", "cap100", "cap300", "reciprocal", "hop1", "hop2", "sybilrank"] as Defense[]) {
    const rs = runAll((s) => runAttack(make(s), 300, "fan", d));
    console.log(
      `${d.padEnd(13)} ${fmt(stats(rs.map((r) => r.targetAfter)), 1).padStart(8)}     ${fmt(stats(rs.map((r) => r.targetScoreMult)), 2).padStart(6)}     ${fmt(stats(rs.map((r) => r.sybilSum)), 4)}   ${fmt(stats(rs.map((r) => r.sybilTop20)), 1).padStart(8)}       ${fmt(stats(rs.map((r) => r.sybilAuc)))}`,
    );
  }

  // ---- TC7: buyer/seller ratio sensitivity ----
  console.log("\n=== TC7 buyer ratio sensitivity (honest) ===");
  for (const br of [0.45, 0.5, 0.55, 0.6]) {
    const rs = runAll((s) => {
      const scn = make(s, { buyerRatio: br });
      const sc = scoresFor(scn, scn.edges, "baseline");
      return { sep: repSeparation(sc, scn.users), g: gini(sc) };
    });
    console.log(`buyerRatio=${br}  separation=${fmt(stats(rs.map((r) => r.sep)))}  gini=${fmt(stats(rs.map((r) => r.g)))}`);
  }

  // ---- TC8: preset distribution sensitivity ----
  console.log("\n=== TC8 preset distribution sensitivity ===");
  const dists: Array<[string, SimConfig["preset"]]> = [
    ["default 25/50/20/5", DEFAULT_SIM.preset],
    ["high-skew 5/5/20/70", { distrust: 0.05, low: 0.05, mid: 0.2, high: 0.7 }],
    ["low-skew 5/70/20/5", { distrust: 0.05, low: 0.7, mid: 0.2, high: 0.05 }],
  ];
  for (const [name, preset] of dists) {
    const rs = runAll((s) => {
      const scn = make(s, { preset });
      const sc = scoresFor(scn, scn.edges, "baseline");
      return { sep: repSeparation(sc, scn.users), g: gini(sc) };
    });
    console.log(`${name.padEnd(20)} separation=${fmt(stats(rs.map((r) => r.sep)))}  gini=${fmt(stats(rs.map((r) => r.g)))}`);
  }

  // ---- TC9: reciprocity on/off honest ----
  {
    const off = runAll((s) => {
      const scn = make(s);
      return repSeparation(scoresFor(scn, scn.edges, "baseline"), scn.users);
    });
    const on = runAll((s) => {
      const scn = make(s);
      return repSeparation(scoresFor(scn, scn.edges, "reciprocal"), scn.users);
    });
    console.log("\n=== TC9 reciprocity (honest) ===");
    console.log(`separation  off=${fmt(stats(off))}  on=${fmt(stats(on))}`);
  }

  console.log("\nNOTE: follow/trust graph is generated, not observed. Distrust=removal. Not a substitute for pilot data.");
}

main();
