// L0 differential fuzz (generator + candidate).
// Emits random weighted digraphs and the TS `computePpr` scores; the networkx
// reference (fuzz_reference.py) recomputes and diffs.
//
//   npx tsx extension/tg/fuzz.ts
//   /path/to/python extension/tg/fuzz_reference.py

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computePpr, type Adjacency } from "./ppr.js";
import { mulberry32 } from "./metrics.js";

const ALPHA = 0.8;
const CASES = 500;
const OUT = process.env.TG_FUZZ_OUT ?? fileURLToPath(new URL("./out/fuzz.json", import.meta.url));

interface FuzzCase {
  root: string;
  nodes: string[];
  edges: Array<[string, string, number]>;
  ts: number[];
}

function main(): void {
  const rnd = mulberry32(20260913);
  const cases: FuzzCase[] = [];

  for (let c = 0; c < CASES; c++) {
    const n = 2 + Math.floor(rnd() * 39); // 2..40 nodes
    const nodes = Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const root = nodes[Math.floor(rnd() * n)]!;
    const edges: Array<[string, string, number]> = [];

    if (c !== 0) {
      // case 0: isolated root, no edges at all.
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i !== j && rnd() < 0.15) edges.push([nodes[i]!, nodes[j]!, 1 + Math.floor(rnd() * 100)]);
        }
      }
      // Occasional parallel edge: nx sums weights, adjacency sums too.
      if (edges.length > 0 && rnd() < 0.3) {
        const e = edges[Math.floor(rnd() * edges.length)]!;
        edges.push([e[0], e[1], 1 + Math.floor(rnd() * 100)]);
      }
    }

    const graph: Adjacency = new Map();
    for (const [u, v, w] of edges) {
      const list = graph.get(u) ?? [];
      list.push({ to: v, weight: w });
      graph.set(u, list);
    }

    const scores = computePpr(graph, root, { alpha: ALPHA });
    cases.push({ root, nodes, edges, ts: nodes.map((nd) => scores.get(nd) ?? 0) });
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ alpha: ALPHA, cases }));
  console.log(`wrote ${cases.length} cases -> ${OUT}`);
}

main();
