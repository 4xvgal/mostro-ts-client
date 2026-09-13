// Trust-graph collection over Nostr (off-Mostro social layer).
// kind 30500 attestation: pubkey = truster,
//   ["p", trustee, relay-hint?], ["w", 0..100], ["d", edge-addr].
//
// Discovery: per-edge `p` hint (one relay, NIP-01/02 convention). Expansion
// asks each trustee's hinted relay first; nodes without a hint fall back to the
// bootstrap relay set. Hint-less attestations are rejected by default.
//
// Bounded collection: because hop expansion is exponential, the walk is capped
// by a total node budget, per-node out-degree, wall-clock deadline, and a
// best-first (priority) frontier. It returns partial results with `truncated`.

import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { Adjacency } from "./ppr.js";

export const ATTESTATION_KIND = 30500;
/** NIP-02 contact list (follow list). */
export const FOLLOW_LIST_KIND = 3;

/** Minimal relay-query surface (SimplePool satisfies it; tests stub it). */
export interface EventSource {
  querySync(relays: string[], filter: Filter, opts?: { maxWait?: number }): Promise<NostrEvent[]>;
  /** Optional live subscription (SimplePool satisfies it). */
  subscribeMany?(relays: string[], filter: Filter, params: SubscribeParams): EventSubscription;
}

export interface SubscribeParams {
  onevent: (event: NostrEvent) => void;
  oneose?: () => void;
  maxWait?: number;
  id?: string;
}

export interface EventSubscription {
  close(): void;
}

/** Minimal publish surface (SimplePool satisfies it). */
export interface EventPublisher {
  publish(relays: string[], event: NostrEvent): Array<Promise<string>>;
}

export interface Attestation {
  truster: string;
  trustee: string;
  /** 0..100 integer per spec; clamped on parse. */
  weight: number;
  /** Replaceable edge address (`tg:v1:<ctx>:<trustee>`), for dedup. */
  d: string;
  createdAt: number;
  /** Relay hint where the trustee's own attestations live, if declared. */
  hint: string | null;
  /** NIP-40 expiration (unix seconds), if set. Expired edges are dropped. */
  expiresAt?: number;
  /** True for locally-seeded edges (private, not fetched/published). */
  local?: boolean;
}

export function isRelayUrl(s: string): boolean {
  return s.startsWith("wss://") || s.startsWith("ws://");
}

function tagValue(event: NostrEvent, name: string): string | null {
  for (const t of event.tags) if (t[0] === name && t[1]) return t[1];
  return null;
}

export function parseAttestation(event: NostrEvent): Attestation | null {
  if (event.kind !== ATTESTATION_KIND) return null;
  let trustee: string | null = null;
  let hint: string | null = null;
  for (const t of event.tags) {
    if (t[0] !== "p" || !t[1]) continue;
    trustee = t[1];
    if (t[2] && isRelayUrl(t[2])) hint = t[2];
    break;
  }
  const d = tagValue(event, "d");
  if (!trustee || !d) return null;
  const raw = Number(tagValue(event, "w") ?? "0");
  const weight = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const exp = Number(tagValue(event, "expiration") ?? "");
  const expiresAt = Number.isFinite(exp) && exp > 0 ? exp : undefined;
  return { truster: event.pubkey, trustee, weight, d, createdAt: event.created_at, hint, expiresAt };
}

/**
 * Build an adjacency list, keeping the newest attestation per (truster, d)
 * (kind 30500 is replaceable, but relays may replay old revisions).
 *
 * Hint-less attestations are rejected by default: without a routing target the
 * trustee cannot be expanded, so accepting it would inject a "hidden leaf"
 * whose out-edges are secret (a PPR manipulation vector). Pass
 * `{ requireHint: false }` only for diagnostics.
 */
export function adjacencyFromAttestations(
  attestations: Attestation[],
  opts: { requireHint?: boolean; now?: number } = {},
): Adjacency {
  const requireHint = opts.requireHint ?? true;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const latest = new Map<string, Attestation>();
  for (const a of attestations) {
    if (requireHint && !a.hint) continue;
    const key = `${a.truster}\n${a.d}`;
    const prev = latest.get(key);
    if (!prev || a.createdAt > prev.createdAt) latest.set(key, a);
  }
  const graph: Adjacency = new Map();
  for (const a of latest.values()) {
    if (a.weight <= 0) continue;
    if (a.expiresAt !== undefined && a.expiresAt <= now) continue; // NIP-40 expiry
    const edges = graph.get(a.truster) ?? [];
    edges.push({ to: a.trustee, weight: a.weight });
    graph.set(a.truster, edges);
  }
  return graph;
}

export interface FetchGraphParams {
  pool: EventSource;
  /** Bootstrap relays: used for the root and for nodes without a hint. */
  relays: string[];
  root: string;
  /** Local seed edges (trusted, not fetched). Their trustees join the first frontier. */
  seed?: SeedEdge[];
  /** Edge hops to expand from root. Default 3. */
  maxHop?: number;
  /** Per-query relay timeout (ms). Default 10s. */
  timeoutMs?: number;
  /** Distinct hints tried per node. Default 3. */
  maxHintsPerNode?: number;
  /** Total node budget (includes root). Default 2000. */
  maxNodes?: number;
  /** Out-edges kept per truster, strongest first. Default 100. */
  maxOutDegreePerNode?: number;
  /** Drop attestations below this weight. Default 0. */
  minEdgeWeight?: number;
  /** Wall-clock budget for the whole collection (ms). Default 2500. */
  deadlineMs?: number;
  /** Reject attestations without a relay hint. Default true. */
  requireHint?: boolean;
}

export interface SeedEdge {
  /** Defaults to the root. */
  from?: string;
  to: string;
  weight: number;
  hint?: string | null;
  createdAt?: number;
}

export interface FetchGraphResult {
  adjacency: Adjacency;
  attestations: Attestation[];
  /** Relays actually queried (for cost/privacy analysis). */
  relaysQueried: string[];
  /** Nodes whose hint relay was used (vs bootstrap fallback). */
  hintedNodes: number;
  /** True when a bound (nodes/deadline/hop) stopped expansion early. */
  truncated: boolean;
}

/**
 * Bounded, best-first BFS expansion of kind 30500 from `root`.
 *
 * Within each hop the frontier is processed highest-priority first (priority
 * approximates PPR mass: parent priority × edge share). Expansion stops at
 * `maxNodes`, `maxOutDegreePerNode`, `deadlineMs`, or `maxHop`.
 */
export async function fetchGraph(params: FetchGraphParams): Promise<FetchGraphResult> {
  const { pool, relays: bootstrap, root } = params;
  const maxHop = params.maxHop ?? 3;
  const timeoutMs = params.timeoutMs ?? 10_000;
  const maxHints = params.maxHintsPerNode ?? 3;
  const maxNodes = params.maxNodes ?? 2000;
  const maxOutDegree = params.maxOutDegreePerNode ?? 100;
  const minWeight = params.minEdgeWeight ?? 0;
  const deadlineMs = params.deadlineMs ?? 2500;
  const requireHint = params.requireHint ?? true;
  const startedAt = performance.now();
  const overDeadline = () => deadlineMs > 0 && performance.now() - startedAt > deadlineMs;

  const queried = new Set<string>();
  const all: Attestation[] = [];
  const hints = new Map<string, Set<string>>();
  const priority = new Map<string, number>();
  const relaysQueried = new Set<string>();
  let hintedNodes = 0;
  let truncated = false;

  // Local seed edges: trusted input, merged into the graph and used to start
  // the walk (their trustees join the first frontier alongside root).
  const seedAtts: Attestation[] = (params.seed ?? []).map((e) => ({
    truster: e.from ?? root,
    trustee: e.to,
    weight: e.weight,
    d: `seed:${e.to}`,
    createdAt: e.createdAt ?? 0,
    hint: e.hint ?? null,
    local: true,
  }));
  for (const a of seedAtts) {
    all.push(a);
    if (a.hint) {
      let set = hints.get(a.trustee);
      if (!set) {
        set = new Set<string>();
        hints.set(a.trustee, set);
      }
      set.add(a.hint);
    }
  }
  const seedSum = seedAtts.reduce((s, a) => s + a.weight, 0) || 1;
  priority.set(root, 1);
  const initial = new Set<string>([root]);
  for (const a of seedAtts) {
    initial.add(a.trustee);
    priority.set(a.trustee, Math.max(priority.get(a.trustee) ?? 0, a.truster === root ? a.weight / seedSum : 1));
  }
  let frontier: string[] = [...initial];

  for (let hop = 0; hop < maxHop && frontier.length > 0; hop++) {
    if (overDeadline()) {
      truncated = true;
      break;
    }
    // Best-first frontier, then trim to the remaining node budget.
    let authors = frontier.filter((a) => !queried.has(a)).sort((a, b) => (priority.get(b) ?? 0) - (priority.get(a) ?? 0));
    const remaining = maxNodes > 0 ? maxNodes - queried.size : authors.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (authors.length > remaining) {
      authors = authors.slice(0, remaining);
      truncated = true;
    }
    for (const a of authors) queried.add(a);

    // Route each author to its hint relays (or the bootstrap set).
    const groups = new Map<string, Set<string>>();
    for (const author of authors) {
      const hs = hints.get(author);
      const use = hs && hs.size > 0 ? [...hs].slice(0, maxHints) : bootstrap;
      if (hs && hs.size > 0) hintedNodes++;
      for (const r of use) {
        let g = groups.get(r);
        if (!g) {
          g = new Set<string>();
          groups.set(r, g);
        }
        g.add(author);
      }
    }

    const hopAtts: Attestation[] = [];
    await Promise.all(
      [...groups].map(async ([relay, authorSet]) => {
        if (overDeadline()) {
          truncated = true;
          return;
        }
        relaysQueried.add(relay);
        let events: NostrEvent[];
        try {
          events = await pool.querySync([relay], { kinds: [ATTESTATION_KIND], authors: [...authorSet] }, { maxWait: timeoutMs });
        } catch {
          return;
        }
        for (const event of events) {
          if (!authorSet.has(event.pubkey)) continue; // untrusted relay
          const att = parseAttestation(event);
          if (!att) continue;
          if (requireHint && !att.hint) continue;
          hopAtts.push(att);
        }
      }),
    );
    if (overDeadline()) truncated = true;

    // Cap each truster's out-degree (strongest edges) and rebuild priority.
    const byTruster = new Map<string, Attestation[]>();
    for (const a of hopAtts) {
      let list = byTruster.get(a.truster);
      if (!list) {
        list = [];
        byTruster.set(a.truster, list);
      }
      list.push(a);
    }
    const next: string[] = [];
    const seenNext = new Set<string>();
    const nextPriority = new Map<string, number>();
    for (const [truster, list] of byTruster) {
      const kept = (maxOutDegree > 0 ? [...list].sort((x, y) => y.weight - x.weight).slice(0, maxOutDegree) : list).filter(
        (a) => a.weight >= minWeight,
      );
      const outSum = kept.reduce((s, a) => s + a.weight, 0);
      const parentPrio = priority.get(truster) ?? 1;
      for (const a of kept) {
        all.push(a);
        if (a.hint) {
          let set = hints.get(a.trustee);
          if (!set) {
            set = new Set<string>();
            hints.set(a.trustee, set);
          }
          set.add(a.hint);
        }
        if (!queried.has(a.trustee) && !seenNext.has(a.trustee)) {
          seenNext.add(a.trustee);
          next.push(a.trustee);
        }
        const childPrio = outSum > 0 ? parentPrio * (a.weight / outSum) : parentPrio;
        nextPriority.set(a.trustee, Math.max(nextPriority.get(a.trustee) ?? 0, childPrio));
      }
    }
    for (const [node, p] of nextPriority) priority.set(node, Math.max(priority.get(node) ?? 0, p));
    frontier = next;
    if (overDeadline()) {
      truncated = true;
      break;
    }
  }

  return {
    adjacency: adjacencyFromAttestations(all, { requireHint: false }),
    attestations: all,
    relaysQueried: [...relaysQueried],
    hintedNodes,
    truncated,
  };
}
