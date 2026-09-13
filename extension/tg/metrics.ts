// Shared numeric helpers for the trust-graph simulations.

/** Deterministic PRNG (mirrors sim.py's mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Score -> 1-based rank (higher score = better rank). */
export function rankOf(scores: Map<string, number>): Map<string, number> {
  const order = [...scores].sort((a, b) => b[1] - a[1]);
  const rank = new Map<string, number>();
  order.forEach(([n], i) => rank.set(n, i + 1));
  return rank;
}

export function topK(scores: Map<string, number>, k: number): Set<string> {
  return new Set([...scores].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n]) => n));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function gini(scores: Map<string, number>): number {
  const v = [...scores.values()].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  const sum = v.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * v[i]!;
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

export function topMass(scores: Map<string, number>, k: number): number {
  return [...scores.values()].sort((a, b) => b - a).slice(0, k).reduce((a, b) => a + b, 0);
}

/** Spearman rank correlation over the common keys of two score maps. */
export function spearman(a: Map<string, number>, b: Map<string, number>): number {
  const common = [...a.keys()].filter((n) => b.has(n));
  if (common.length < 3) return 1;
  const ra = rankOf(new Map(common.map((n) => [n, a.get(n)!])));
  const rb = rankOf(new Map(common.map((n) => [n, b.get(n)!])));
  const n = common.length;
  let sum = 0;
  for (const x of common) {
    const d = ra.get(x)! - rb.get(x)!;
    sum += d * d;
  }
  return 1 - (6 * sum) / (n * (n * n - 1));
}

/** Tie-aware Mann-Whitney AUC: how well scores separate pos from neg. */
export function auc(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return 0.5;
  const all = [...pos.map((s) => ({ s, y: 1 })), ...neg.map((s) => ({ s, y: 0 }))].sort((a, b) => a.s - b.s);
  const ranks = new Map<number, number>();
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.s === all[i]!.s) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.set(k, avg);
    i = j + 1;
  }
  let rankSum = 0;
  all.forEach((e, idx) => {
    if (e.y === 1) rankSum += ranks.get(idx)!;
  });
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

export interface Agg {
  mean: number;
  ci: number;
}

export function agg(xs: number[]): Agg {
  if (xs.length === 0) return { mean: 0, ci: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean, ci: 0 };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, ci: (1.96 * Math.sqrt(variance)) / Math.sqrt(xs.length) };
}

export function fmt(a: Agg, digits = 3): string {
  return `${a.mean.toFixed(digits)}±${a.ci.toFixed(digits)}`;
}
