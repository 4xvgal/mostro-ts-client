// Scoring strategy: swap the PPR variant without touching TrustGraph.

import { computePpr, type Adjacency } from "./ppr.js";

/** Pure scorer: (graph, seed) -> per-identity score. */
export type Scorer = (graph: Adjacency, seed: string) => Map<string, number>;

/** Default scorer: personalized PageRank, α=0.8, dangling -> seed. */
export function pprScorer(alpha = 0.8): Scorer {
  return (graph, seed) => computePpr(graph, seed, { alpha });
}
