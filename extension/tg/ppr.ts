// Personalized PageRank over a trust-graph adjacency list.
// Frozen semantics for mostro-trust-graph-spec v0.1.1:
//   - directed edges truster -> trustee
//   - row-normalize out-weights (w is 0..100, only ratios matter)
//   - damping alpha = 0.8
//   - dangling mass (nodes with no out-edges) restarts at the root
//     (networkx `nx.pagerank` default; the reference used by test/ppr/sim.py)

export type Adjacency = Map<string, Array<{ to: string; weight: number }>>;

export interface PprOptions {
  /** Damping / restart probability. Default 0.8. */
  alpha?: number;
  /** Power-iteration cap. Default 200. */
  maxIter?: number;
  /** L1 convergence threshold. Default 1e-12. */
  tol?: number;
}

/**
 * Pure `compute_ppr(graph, root, alpha)`.
 *
 * Dangling nodes redistribute their mass to the personalization vector
 * (root = 1.0), i.e. the walk restarts at the root. Scores sum to 1.
 */
export function computePpr(
  graph: Adjacency,
  root: string,
  opts: PprOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? 0.8;
  const maxIter = opts.maxIter ?? 200;
  const tol = opts.tol ?? 1e-12;

  const idx = new Map<string, number>();
  const nodes: string[] = [];
  const addNode = (n: string): number => {
    const existing = idx.get(n);
    if (existing !== undefined) return existing;
    const i = nodes.length;
    idx.set(n, i);
    nodes.push(n);
    return i;
  };
  addNode(root);
  for (const [u, edges] of graph) {
    addNode(u);
    for (const e of edges) addNode(e.to);
  }

  // Pre-normalized out-edges + out-weight sums per node.
  const outSum = new Float64Array(nodes.length);
  const out: Array<Array<[number, number]>> = nodes.map(() => []);
  for (const [u, edges] of graph) {
    const ui = idx.get(u)!;
    let s = 0;
    for (const e of edges) if (e.weight > 0) s += e.weight;
    outSum[ui] = s;
    if (s <= 0) continue;
    for (const e of edges) {
      if (e.weight <= 0) continue;
      out[ui]!.push([idx.get(e.to)!, e.weight / s]);
    }
  }

  const pers = new Float64Array(nodes.length);
  pers[idx.get(root)!] = 1;

  const n = nodes.length;
  let v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = 1 / n;

  for (let it = 0; it < maxIter; it++) {
    const nv = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outSum[i]! <= 0) {
        dangling += v[i]!;
        continue;
      }
      const vi = v[i]!;
      for (const [j, w] of out[i]!) nv[j] = nv[j]! + alpha * vi * w;
    }
    // Dangling mass + teleport both go to the personalization vector.
    for (let i = 0; i < n; i++) {
      nv[i] = nv[i]! + (alpha * dangling + (1 - alpha)) * pers[i]!;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs(nv[i]! - v[i]!);
    v = nv;
    if (diff < tol) break;
  }

  const scores = new Map<string, number>();
  for (let i = 0; i < n; i++) scores.set(nodes[i]!, v[i]!);
  return scores;
}
