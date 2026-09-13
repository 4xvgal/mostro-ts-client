// L1 parameter sensitivity + sybil red-team, offline, on the harvested
// follow graph (topology stress, not calibration — see notes at the end).
//
//   npx tsx extension/tg/sweep.ts
//
// Measures: alpha rank-sensitivity, hop convergence, out-degree cap effect,
// and sybil farming vs alpha. Uses the production computePpr engine.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computePpr, type Adjacency } from "./ppr.js";
import { mulberry32, rankOf, topK, jaccard, spearman, gini, topMass } from "./metrics.js";

const FILE = process.env.TG_GRAPH ?? fileURLToPath(new URL("./out/follow-graph.json", import.meta.url));
const ALPHAS = [0.5, 0.7, 0.8, 0.85, 0.9];
const HOPS = [1, 2, 3, 4];
const CAPS = [0, 100, 300, 1000]; // 0 = no cap
const ROOT_COUNT = Number(process.env.TG_ROOTS ?? 5);
const SYBILS = Number(process.env.TG_SYBILS ?? 30);

type Indexed = { nodes: string[]; out: Array<Array<[number, number]>> }; // [targetIdx, weight]

function loadIndexed(): Indexed {
  const raw = JSON.parse(readFileSync(FILE, "utf8")) as { nodes: string[]; edges: Array<[number, number]> };
  const out: Array<Array<[number, number]>> = raw.nodes.map(() => []);
  for (const [a, b] of raw.edges) out[a]!.push([b, 1]); // uniform weight
  return { nodes: raw.nodes, out };
}

/** BFS to maxHop from root; returns a Map<string, ...> adjacency restricted to reached nodes. */
function buildLocal(g: Indexed, root: number, maxHop: number): { adj: Adjacency; reached: number } {
  const keep = new Set<number>([root]);
  let frontier = [root];
  for (let h = 0; h < maxHop; h++) {
    const next: number[] = [];
    for (const u of frontier) for (const [v] of g.out[u]!) if (!keep.has(v)) { keep.add(v); next.push(v); }
    frontier = next;
  }
  const adj: Adjacency = new Map();
  const id = (i: number) => g.nodes[i]!;
  for (const u of keep) {
    const es = g.out[u]!.filter(([v]) => keep.has(v)).map(([v]) => ({ to: id(v), weight: 1 }));
    if (es.length) adj.set(id(u), es);
  }
  return { adj, reached: keep.size };
}

function capAdjacency(adj: Adjacency, cap: number): Adjacency {
  if (cap <= 0) return adj;
  const out: Adjacency = new Map();
  for (const [u, es] of adj) out.set(u, es.length > cap ? es.slice(0, cap) : es);
  return out;
}

function cloneAdj(adj: Adjacency): Adjacency {
  const out: Adjacency = new Map();
  for (const [u, es] of adj) out.set(u, es.map((e) => ({ ...e })));
  return out;
}

/** sim.py-style sparse sybil cluster: bridge -> each sybil, sparse mutual links, farm to target. */
function injectSybils(
  adj: Adjacency,
  bridge: string,
  target: string,
  n: number,
  degree = 3,
  wTrust = 20,
  wSybil = 20,
  wFarm = 100,
): { graph: Adjacency; sybils: string[] } {
  const g = cloneAdj(adj);
  const add = (u: string, v: string, w: number) => {
    const list = g.get(u) ?? [];
    list.push({ to: v, weight: w });
    g.set(u, list);
  };
  const sybils: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = `sybil${i}`;
    sybils.push(s);
    add(bridge, s, wTrust);
    for (const p of sybils.slice(Math.max(0, sybils.length - 1 - degree), -1)) {
      add(s, p, wSybil);
      add(p, s, wSybil);
    }
    add(s, target, wFarm);
  }
  return { graph: g, sybils };
}

function main(): void {
  const g = loadIndexed();
  const rnd = mulberry32(20260913);
  const sources = g.nodes.map((_, i) => i).filter((i) => g.out[i]!.length > 0);
  const roots: number[] = [];
  while (roots.length < ROOT_COUNT && sources.length) {
    const pick = sources[Math.floor(rnd() * sources.length)]!;
    if (!roots.includes(pick)) roots.push(pick);
  }
  if (roots.length === 0) throw new Error(`no source nodes in ${FILE}`);
  console.log(`graph: ${g.nodes.length} nodes, ${g.out.reduce((a, l) => a + l.length, 0)} edges, roots=${roots.length}`);

  // ---- alpha sensitivity (hop=3, cap=none) ----
  console.log("\n=== ALPHA SENSITIVITY (hop=3, no cap; avg over roots) ===");
  console.log("pair            top20-jaccard  spearman");
  const baseScores = new Map<number, Map<string, number>>();
  for (const r of roots) {
    const { adj } = buildLocal(g, r, 3);
    baseScores.set(r, computePpr(adj, g.nodes[r]!, { alpha: 0.8 }));
  }
  for (let i = 0; i < ALPHAS.length - 1; i++) {
    let jac = 0, sp = 0, used = 0;
    for (const r of roots) {
      const { adj } = buildLocal(g, r, 3);
      const a = computePpr(adj, g.nodes[r]!, { alpha: ALPHAS[i]! });
      const b = computePpr(adj, g.nodes[r]!, { alpha: ALPHAS[i + 1]! });
      jac += jaccard(topK(a, 20), topK(b, 20));
      sp += spearman(a, b);
      used++;
    }
    console.log(`a=${ALPHAS[i]} -> ${ALPHAS[i + 1]}     ${(jac / used).toFixed(3)}          ${(sp / used).toFixed(4)}`);
  }

  // ---- hop convergence (alpha=0.8, cap=none) ----
  console.log("\n=== HOP CONVERGENCE (alpha=0.8, no cap) ===");
  console.log("hop  reached(avg)  top10-mass(avg)  gini(avg)  new-vs-prev-jaccard");
  let prevTop: Array<Set<string>> | null = null;
  for (const hop of HOPS) {
    let reached = 0, mass = 0, gi = 0;
    const tops: Array<Set<string>> = [];
    for (const r of roots) {
      const { adj, reached: n } = buildLocal(g, r, hop);
      const sc = computePpr(adj, g.nodes[r]!, { alpha: 0.8 });
      reached += n;
      mass += topMass(sc, 10);
      gi += gini(sc);
      tops.push(topK(sc, 20));
    }
    const jacPrev = prevTop ? tops.reduce((acc, t, i) => acc + jaccard(t, prevTop![i]!), 0) / roots.length : 1;
    console.log(`${hop}    ${(reached / roots.length).toFixed(0).padStart(6)}       ${(mass / roots.length).toFixed(4).padStart(6)}          ${(gi / roots.length).toFixed(3)}     ${jacPrev.toFixed(3)}`);
    prevTop = tops;
  }

  // ---- out-degree cap (alpha=0.8, hop=3) ----
  console.log("\n=== OUT-DEGREE CAP (alpha=0.8, hop=3) ===");
  console.log("cap     top10-mass(avg)  gini(avg)  top20-vs-nocap");
  const noCapTops: Array<Set<string>> = [];
  for (const r of roots) noCapTops.push(topK(baseScores.get(r)!, 20));
  for (const cap of CAPS) {
    let mass = 0, gi = 0, jac = 0;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i]!;
      const { adj } = buildLocal(g, r, 3);
      const sc = computePpr(capAdjacency(adj, cap), g.nodes[r]!, { alpha: 0.8 });
      mass += topMass(sc, 10);
      gi += gini(sc);
      jac += jaccard(topK(sc, 20), noCapTops[i]!);
    }
    console.log(`${String(cap || "none").padEnd(6)}  ${(mass / roots.length).toFixed(4).padStart(6)}          ${(gi / roots.length).toFixed(3)}     ${(jac / roots.length).toFixed(3)}`);
  }

  // ---- sybil farming vs alpha (hop=3, no cap) ----
  console.log(`\n=== SYBIL FARMING vs ALPHA (hop=3, no cap, n=${SYBILS}) ===`);
  console.log("alpha  target-rank before  after  sybil-score-sum  sybil-in-top20");
  for (const alpha of ALPHAS) {
    let before = 0, after = 0, ssum = 0, inTop = 0;
    for (const r of roots) {
      const { adj } = buildLocal(g, r, 3);
      const rootId = g.nodes[r]!;
      const baseRank = rankOf(computePpr(adj, rootId, { alpha }));
      const nodes = [...adj.keys()];
      const bridge = nodes[1] ?? nodes[0]!;
      const target = nodes[2] ?? nodes[0]!;
      const { graph: atkAdj, sybils } = injectSybils(adj, bridge, target, SYBILS);
      const atk = computePpr(atkAdj, rootId, { alpha });
      const atkRank = rankOf(atk);
      before += baseRank.get(target) ?? baseRank.size;
      after += atkRank.get(target) ?? atkRank.size;
      ssum += sybils.reduce((a, s) => a + (atk.get(s) ?? 0), 0);
      const t20 = topK(atk, 20);
      inTop += sybils.filter((s) => t20.has(s)).length;
    }
    const n = roots.length;
    console.log(`${alpha.toFixed(2)}   ${(before / n).toFixed(1).padStart(6)}          ${(after / n).toFixed(1).padStart(5)}   ${(ssum / n).toFixed(6)}        ${(inTop / n).toFixed(1)}`);
  }

  // ---- sybil vs out-degree cap (alpha=0.8, hop=3) ----
  console.log("\n=== SYBIL vs OUT-DEGREE CAP (alpha=0.8, hop=3) ===");
  console.log("cap     target-rank-after  sybil-score-sum  sybils-in-top20");
  for (const cap of CAPS) {
    let after = 0, ssum = 0, inTop = 0;
    for (const r of roots) {
      const { adj } = buildLocal(g, r, 3);
      const rootId = g.nodes[r]!;
      const nodes = [...adj.keys()];
      const bridge = nodes[1] ?? nodes[0]!;
      const target = nodes[2] ?? nodes[0]!;
      const { graph: atkAdj, sybils } = injectSybils(adj, bridge, target, SYBILS);
      const capped = capAdjacency(atkAdj, cap);
      const atk = computePpr(capped, rootId, { alpha: 0.8 });
      after += rankOf(atk).get(target) ?? atk.size;
      ssum += sybils.reduce((a, s) => a + (atk.get(s) ?? 0), 0);
      inTop += sybils.filter((s) => topK(atk, 20).has(s)).length;
    }
    const n = roots.length;
    console.log(`${String(cap || "none").padEnd(6)}  ${(after / n).toFixed(1).padStart(6)}             ${(ssum / n).toFixed(6)}         ${(inTop / n).toFixed(1)}`);
  }
  console.log("  caveat: cap slices the FIRST `cap` out-edges; sybil edges are appended last, so a");
  console.log("  high-degree bridge drops them — an ordering artifact, not a robust defence.");

  console.log("\nNOTE: follow graph != trust graph. This is a topology stress test; real calibration needs pilot data.");
}

main();
