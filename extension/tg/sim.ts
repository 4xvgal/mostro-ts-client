// Human-like Mostro trust-graph generator.
//
// Edges arise only from completed trades + a rating. Weights come from the UI
// presets, not arbitrary numbers. Distrust (못믿음) is the "removal" model:
// weight 0 -> no edge is created.
//
//   buyer/seller split slightly buyer-heavy; trades prefer the same community
//   and reputable sellers; a fraction of trades produce mutual ratings.

import type { Adjacency } from "./ppr.js";
import { mulberry32 } from "./metrics.js";

export const PRESET_W = { distrust: 0, low: 20, mid: 50, high: 90 } as const;

export type Role = "buyer" | "seller";

export interface SimUser {
  id: string;
  role: Role;
  community: number;
  reputation: number;
}

export interface EdgeRecord {
  from: string;
  to: string;
  weight: number;
  tick: number;
}

export interface SimConfig {
  seed: number;
  users: number;
  buyerRatio: number;
  communityCount: number;
  ticks: number;
  tradesPerTick: number;
  pAttest: number;
  pMutual: number;
  pSameCommunity: number;
  /** Preset choice probabilities (must sum to 1). */
  preset: { distrust: number; low: number; mid: number; high: number };
  rootCommunity: number;
}

export const DEFAULT_SIM: SimConfig = {
  seed: 1,
  users: 2000,
  buyerRatio: 0.55,
  communityCount: 20,
  ticks: 40,
  tradesPerTick: 100,
  pAttest: 0.4,
  pMutual: 0.7,
  pSameCommunity: 0.9,
  preset: { distrust: 0.05, low: 0.25, mid: 0.5, high: 0.2 },
  rootCommunity: 0,
};

export interface Scenario {
  config: SimConfig;
  users: SimUser[];
  edges: EdgeRecord[];
  root: string;
}

function pickPresetWeight(rnd: () => number, p: SimConfig["preset"]): number {
  const r = rnd();
  let acc = p.distrust;
  if (r < acc) return PRESET_W.distrust;
  acc += p.low;
  if (r < acc) return PRESET_W.low;
  acc += p.mid;
  if (r < acc) return PRESET_W.mid;
  return PRESET_W.high;
}

function weightedPick<T>(rnd: () => number, pool: T[], weight: (t: T) => number): T {
  let total = 0;
  for (const t of pool) total += weight(t);
  let r = rnd() * total;
  for (const t of pool) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return pool[pool.length - 1]!;
}

export function generateScenario(overrides: Partial<SimConfig> = {}): Scenario {
  const cfg: SimConfig = { ...DEFAULT_SIM, ...overrides };
  const rnd = mulberry32(cfg.seed);

  const users: SimUser[] = [];
  for (let i = 0; i < cfg.users; i++) {
    users.push({
      id: `u${i}`,
      role: rnd() < cfg.buyerRatio ? "buyer" : "seller",
      community: Math.floor(rnd() * cfg.communityCount),
      reputation: 0,
    });
  }
  const buyers = users.filter((u) => u.role === "buyer");
  const sellers = users.filter((u) => u.role === "seller");
  if (buyers.length === 0 || sellers.length === 0) throw new Error("need both buyers and sellers");

  // Latest rating per (truster, trustee); distrust (w=0) removes any prior edge.
  const edgeMap = new Map<string, EdgeRecord>();
  const key = (a: string, b: string) => `${a}|${b}`;
  const rate = (from: SimUser, to: SimUser, w: number, tick: number) => {
    const k = key(from.id, to.id);
    if (w <= 0) {
      edgeMap.delete(k); // 못믿음 -> removal
      return;
    }
    edgeMap.set(k, { from: from.id, to: to.id, weight: w, tick });
  };

  for (let tick = 0; tick < cfg.ticks; tick++) {
    for (let t = 0; t < cfg.tradesPerTick; t++) {
      const buyer = buyers[Math.floor(rnd() * buyers.length)]!;
      const pool =
        rnd() < cfg.pSameCommunity
          ? sellers.filter((s) => s.community === buyer.community)
          : sellers;
      if (pool.length === 0) continue;
      const seller = weightedPick(rnd, pool, (s) => 1 + s.reputation);
      seller.reputation += 1;

      if (rnd() < cfg.pAttest) rate(buyer, seller, pickPresetWeight(rnd, cfg.preset), tick);
      if (rnd() < cfg.pMutual) rate(seller, buyer, pickPresetWeight(rnd, cfg.preset), tick);
    }
  }

  const edges = [...edgeMap.values()];
  const rootUser =
    buyers.find((u) => u.community === cfg.rootCommunity) ?? buyers[0]!;
  return { config: cfg, users, edges, root: rootUser.id };
}

export interface AdjacencyFilter {
  cap?: number;
  requireReciprocal?: boolean;
  window?: number;
  nowTick?: number;
  decay?: number;
}

export function toAdjacency(edges: EdgeRecord[], filter: AdjacencyFilter = {}): Adjacency {
  let es = edges;
  if (filter.window !== undefined) {
    const now = filter.nowTick ?? Math.max(...es.map((e) => e.tick), 0);
    es = es.filter((e) => now - e.tick <= filter.window!);
  }
  if (filter.requireReciprocal) {
    const set = new Set(es.map((e) => `${e.from}|${e.to}`));
    es = es.filter((e) => set.has(`${e.to}|${e.from}`));
  }
  const decay = filter.decay ?? 1;
  const now = filter.nowTick ?? 0;
  const adj: Adjacency = new Map();
  for (const e of es) {
    const w = decay === 1 ? e.weight : e.weight * Math.pow(decay, now - e.tick);
    if (w <= 0) continue;
    const list = adj.get(e.from) ?? [];
    list.push({ to: e.to, weight: w });
    adj.set(e.from, list);
  }
  if (filter.cap && filter.cap > 0) {
    for (const [u, list] of adj) {
      if (list.length > filter.cap) adj.set(u, list.slice(0, filter.cap));
    }
  }
  return adj;
}

export interface SybilOptions {
  bridge: string;
  target: string;
  size: number;
  entry?: "fan" | "anchor";
  degree?: number;
  weight?: number;
  farmWeight?: number;
  /** Tick to stamp the injected edges (fresh burst = latest tick). */
  tick?: number;
}

/** Attacker cluster: bridge -> sybils (fan or anchor), sparse mutual links, farm to target. */
export function injectSybilFarm(
  edges: EdgeRecord[],
  users: SimUser[],
  opts: SybilOptions,
): { edges: EdgeRecord[]; sybils: SimUser[] } {
  const { bridge, target, size } = opts;
  const entry = opts.entry ?? "fan";
  const degree = opts.degree ?? 3;
  const w = opts.weight ?? PRESET_W.high;
  const farm = opts.farmWeight ?? PRESET_W.high;
  const tk = opts.tick ?? 0;
  const out = [...edges];
  const sybils: SimUser[] = [];
  for (let i = 0; i < size; i++) {
    const id = `sybil${i}`;
    sybils.push({ id, role: "seller", community: -1, reputation: 0 });
    if (entry === "fan" || i === 0) out.push({ from: bridge, to: id, weight: w, tick: tk });
    for (const p of sybils.slice(Math.max(0, sybils.length - 1 - degree), -1)) {
      out.push({ from: id, to: p.id, weight: w, tick: tk });
      out.push({ from: p.id, to: id, weight: w, tick: tk });
    }
    out.push({ from: id, to: target, weight: farm, tick: tk });
  }
  return { edges: out, sybils: [...users, ...sybils] };
}

/** Restrict an adjacency to nodes within `hop` of root (edges to outside dropped). */
export function hopRestrict(adj: Adjacency, root: string, hop: number): Adjacency {
  const keep = new Set<string>([root]);
  let frontier = [root];
  for (let h = 0; h < hop; h++) {
    const next: string[] = [];
    for (const u of frontier) for (const e of adj.get(u) ?? []) if (!keep.has(e.to)) { keep.add(e.to); next.push(e.to); }
    frontier = next;
  }
  const out: Adjacency = new Map();
  for (const [u, es] of adj) {
    if (!keep.has(u)) continue;
    const kept = es.filter((e) => keep.has(e.to));
    if (kept.length) out.set(u, kept);
  }
  return out;
}

export function sellersOf(users: SimUser[]): SimUser[] {
  return users.filter((u) => u.role === "seller");
}

/** Mean reputation of the top-K scored sellers / overall mean. >1 = score tracks reputation. */
export function reputationSeparation(scores: Map<string, number>, users: SimUser[], k = 20): number {
  const sellers = sellersOf(users);
  const ranked = sellers.slice().sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  const top = ranked.slice(0, k).reduce((a, u) => a + u.reputation, 0) / k;
  const all = sellers.reduce((a, u) => a + u.reputation, 0) / sellers.length;
  return all === 0 ? 1 : top / all;
}
