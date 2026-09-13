// TrustGraph facade API: maker-side order binding + viewer-side scoring.
//
// Maker:  buildOrderBinding(...) -> pm token embedded in the order's pm field.
// Viewer: new TrustGraph({pool, relays, root}).refresh() -> score(identity),
//         verifyOrderBinding(orderEvent, identity) -> resolved/verified,
//         classify({identity, rating}) -> badge.
//
// Core is not modified; this wraps the pure token/ppr/graph primitives.

import type { NostrEvent } from "nostr-tools/core";
import { NOSTR_ORDER_EVENT_KIND, type SmallOrder } from "../../src/protocol/index.js";
import { ATTESTATION_KIND, fetchGraph, adjacencyFromAttestations, parseAttestation, type Attestation, type EventSource, type EventPublisher, type EventSubscription, type SeedEdge } from "./graph.js";
import type { Adjacency } from "./ppr.js";
import { pprScorer, type Scorer } from "./scorer.js";
import { MemoryTrustGraphStore, type TrustGraphStore } from "./store.js";
import { FirstSeenTracker, type SeenVerdict } from "./firstSeen.js";
import { attestationDTag, buildAttestation, buildRevoke, contextFromDTag } from "./attest.js";
import { publishEvent, PublishError, type PublishReport, type PublishResult } from "./publish.js";
import { noopTelemetry, type TelemetryEvent, type TelemetrySink } from "./telemetry.js";
import {
  buildPmToken,
  verifyPmToken,
  canonicalBase,
  insertToken,
  extractTokenFromSegments,
  splitPm,
  type TgChallengeInput,
} from "./token.js";

// ---------------- maker side ----------------

export type OrderBindingParams = {
  identitySecretHex: string;
  mostroPubkey: string;
  kind: "buy" | "sell";
  fiatCode: string;
  premium: number;
  basePaymentMethod: string;
} & ({ fiatAmount: number } | { minAmount: number; maxAmount: number });

/** Build the pm value (canonical base + binding token) for a new order. */
export function buildOrderBinding(p: OrderBindingParams): { token: string; pm: string } {
  const base = canonicalBase(p.basePaymentMethod);
  const common = {
    mostroPubkey: p.mostroPubkey,
    kind: p.kind,
    fiatCode: p.fiatCode,
    premium: p.premium,
    basePaymentMethod: base,
  };
  const input: TgChallengeInput =
    "fiatAmount" in p
      ? { ...common, fiatAmount: p.fiatAmount }
      : { ...common, variant: "v1r", minAmount: p.minAmount, maxAmount: p.maxAmount };
  const token = buildPmToken(input, p.identitySecretHex);
  return { token, pm: insertToken(base, token) };
}

// ---------------- viewer side: order -> identity ----------------

export type OrderBindingResult =
  | { ok: true; base: string; token: string }
  | { ok: false; reason: "no-token" | "multi-token" | "sig-mismatch" | "bad-fields" };

function tagValues(tags: string[][], name: string): string[] {
  return tags.filter((t) => t[0] === name).flatMap((t) => t.slice(1));
}

/**
 * Reconstruct the challenge from the actual kind-38383 tags and verify the
 * token against a claimed identity. `identityPubkeyHex` comes from the social
 * index (30501) or a DM payload — not from the order itself.
 */
export function verifyOrderBinding(
  orderEvent: Pick<NostrEvent, "pubkey" | "tags">,
  identityPubkeyHex: string,
): OrderBindingResult {
  const segments = tagValues(orderEvent.tags, "pm");
  const tokens = segments.filter((s) => s.startsWith("tg:v1~") || s.startsWith("tg:v1r~"));
  if (tokens.length === 0) return { ok: false, reason: "no-token" };
  if (tokens.length > 1) return { ok: false, reason: "multi-token" };
  const ex = extractTokenFromSegments(segments)!;
  const k = tagValues(orderEvent.tags, "k")[0];
  const f = tagValues(orderEvent.tags, "f")[0];
  const premiumRaw = tagValues(orderEvent.tags, "premium")[0];
  const fa = tagValues(orderEvent.tags, "fa");
  if (k === undefined || f === undefined || premiumRaw === undefined || fa.length === 0) {
    return { ok: false, reason: "bad-fields" };
  }
  const common = {
    mostroPubkey: orderEvent.pubkey,
    kind: k,
    fiatCode: f,
    premium: Number(premiumRaw),
    basePaymentMethod: ex.base,
  };
  const input: TgChallengeInput =
    fa.length >= 2
      ? { ...common, variant: "v1r", minAmount: Number(fa[0]), maxAmount: Number(fa[1]) }
      : { ...common, fiatAmount: Number(fa[0]) };
  return verifyPmToken(input, ex.token, identityPubkeyHex)
    ? { ok: true, base: ex.base, token: ex.token }
    : { ok: false, reason: "sig-mismatch" };
}

/**
 * Same as `verifyOrderBinding` but from a parsed `SmallOrder` (the client's
 * order-book shape) instead of a raw event. `mostroPubkey` is the daemon key.
 */
export function verifyOrderBindingFromOrder(
  order: SmallOrder,
  mostroPubkey: string,
  identityPubkeyHex: string,
): OrderBindingResult {
  const segments = splitPm(order.payment_method);
  const tokens = segments.filter((s) => s.startsWith("tg:v1~") || s.startsWith("tg:v1r~"));
  if (tokens.length === 0) return { ok: false, reason: "no-token" };
  if (tokens.length > 1) return { ok: false, reason: "multi-token" };
  const ex = extractTokenFromSegments(segments)!;
  if (order.kind === null || order.fiat_code === "") return { ok: false, reason: "bad-fields" };
  const common = {
    mostroPubkey,
    kind: String(order.kind),
    fiatCode: order.fiat_code,
    premium: order.premium,
    basePaymentMethod: ex.base,
  };
  const input: TgChallengeInput =
    order.min_amount !== null && order.max_amount !== null
      ? { ...common, variant: "v1r", minAmount: order.min_amount, maxAmount: order.max_amount }
      : { ...common, fiatAmount: order.fiat_amount };
  return verifyPmToken(input, ex.token, identityPubkeyHex)
    ? { ok: true, base: ex.base, token: ex.token }
    : { ok: false, reason: "sig-mismatch" };
}

// ---------------- viewer side: graph + score ----------------

export interface TrustGraphOptions {
  pool: EventSource;
  /** Community bootstrap relays. */
  relays: string[];
  /** The viewer's own identity pubkey (PPR seed). */
  root: string;
  maxHop?: number;
  alpha?: number;
  requireHint?: boolean;
  /** Drop attestations with no reciprocal edge (spec §7 "strict mode"). Default false. */
  hardReciprocal?: boolean;
  /** Total node budget (includes root). Default 2000. */
  maxNodes?: number;
  /** Out-edges kept per truster, strongest first. Default 100. */
  maxOutDegreePerNode?: number;
  /** Drop attestations below this weight. Default 0. */
  minEdgeWeight?: number;
  /** Wall-clock collection budget (ms). Default 2500. */
  deadlineMs?: number;
  /** Ignore a persisted attestation cache older than this (ms). Default: never expires. */
  cacheTtlMs?: number;
  /** Local seed edges (private; not necessarily published). */
  seed?: SeedEdge[];
  /** Scoring strategy. Default: PPR with the configured alpha. */
  scorer?: Scorer;
  /** Persistence for collected attestations + first-seen ledger. Default: in-memory. */
  store?: TrustGraphStore;
  /** Publisher for attestation authoring. Default: `pool` if it has publish(). */
  publisher?: EventPublisher;
  /** Enable live subscription on start(). Default true. */
  live?: boolean;
  /** Debounce (ms) for live attestation persist+recompute. Default 250. */
  liveDebounceMs?: number;
  /** Called for each live kind-38383 order event (for resolve/annotate). */
  onOrderEvent?: (event: NostrEvent) => void;
  /** Anonymous aggregate telemetry sink (no identities / order ids). */
  telemetry?: TelemetrySink;
  onUpdate?: (snapshot: TrustGraphSnapshot) => void;
}

export interface TrustGraphSnapshot {
  root: string;
  nodes: number;
  edges: number;
  scores: Map<string, number>;
  /** True when the collection hit a bound and returned partial results. */
  truncated: boolean;
  updatedAt: number;
}

export type TrustState = "도달" | "미도달" | "UNRATED" | "farm-suspect";

export interface TrustBadge {
  state: TrustState;
  score?: number;
  reasons: string[];
}

function dropNonMutual(adj: Adjacency): Adjacency {
  const pairs = new Set<string>();
  for (const [u, es] of adj) for (const e of es) pairs.add(`${u}\n${e.to}`);
  const out: Adjacency = new Map();
  for (const [u, es] of adj) {
    const kept = es.filter((e) => pairs.has(`${e.to}\n${u}`));
    if (kept.length) out.set(u, kept);
  }
  return out;
}

/** Merge attestations into an adjacency with per-node out-degree cap / min weight. */
function cappedAdjacency(
  atts: Attestation[],
  opts: { maxOutDegree?: number; minEdgeWeight?: number; hardReciprocal?: boolean },
): Adjacency {
  let adj = adjacencyFromAttestations(atts, { requireHint: false });
  const min = opts.minEdgeWeight ?? 0;
  if (min > 0) {
    const filtered: Adjacency = new Map();
    for (const [u, es] of adj) {
      const kept = es.filter((e) => e.weight >= min);
      if (kept.length) filtered.set(u, kept);
    }
    adj = filtered;
  }
  if (opts.maxOutDegree && opts.maxOutDegree > 0) {
    const capped: Adjacency = new Map();
    for (const [u, es] of adj) {
      capped.set(u, es.length > opts.maxOutDegree ? [...es].sort((a, b) => b.weight - a.weight).slice(0, opts.maxOutDegree) : es);
    }
    adj = capped;
  }
  if (opts.hardReciprocal) adj = dropNonMutual(adj);
  return adj;
}

function countNodes(adj: Adjacency): number {
  const s = new Set<string>();
  for (const [u, es] of adj) {
    s.add(u);
    for (const e of es) s.add(e.to);
  }
  return s.size;
}

function countEdges(adj: Adjacency): number {
  let n = 0;
  for (const es of adj.values()) n += es.length;
  return n;
}

/**
 * Viewer-side trust graph. `refresh()` collects the kind-30500 neighborhood
 * around `root` and computes PPR. Scores are root-relative.
 */
export class TrustGraph {
  private readonly opts: TrustGraphOptions;
  private readonly localSeeds: SeedEdge[];
  private readonly scorer: Scorer;
  private readonly store: TrustGraphStore;
  private readonly publisher: EventPublisher | null;
  private readonly telemetry: TelemetrySink;
  private readonly firstSeen = new FirstSeenTracker();
  /** Attestations seen so far, keyed by truster|d (accumulates across refreshes). */
  private cache = new Map<string, Attestation>();
  private adjacency: Adjacency = new Map();
  private scores: Map<string, number> = new Map();
  private sortedScores: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private subs: EventSubscription[] = [];
  private hydrated = false;

  constructor(opts: TrustGraphOptions) {
    this.opts = opts;
    this.localSeeds = [...(opts.seed ?? [])];
    this.scorer = opts.scorer ?? pprScorer(opts.alpha ?? 0.8);
    this.store = opts.store ?? new MemoryTrustGraphStore();
    const maybe = opts.pool as { publish?: unknown };
    this.publisher = opts.publisher ?? (typeof maybe.publish === "function" ? (opts.pool as unknown as EventPublisher) : null);
    this.telemetry = opts.telemetry ?? noopTelemetry;
  }

  private track(event: TelemetryEvent): void {
    try {
      this.telemetry.emit(event);
    } catch {
      // telemetry must never break the app
    }
  }

  /** Load persisted attestations + first-seen ledger once. */
  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const snap = await this.store.loadAttestations();
    const fresh = snap !== null && (!this.opts.cacheTtlMs || Date.now() - snap.savedAt <= this.opts.cacheTtlMs);
    if (fresh && snap) for (const a of snap.attestations) this.cache.set(`${a.truster}\n${a.d}`, a);
    this.firstSeen.importState(await this.store.loadFirstSeen());
  }

  /**
   * First-seen check keyed on local OBSERVATION order (spec §12). Uses the
   * order's first-observed time (recorded live) — never the relay's event
   * created_at, which is the latest revision and can be inverted by revisions.
   */
  observeOrder(p: { identity: string; nonce: Uint8Array; orderId: string; observedAt?: number }): SeenVerdict {
    const observedAt = p.observedAt ?? this.firstSeen.birthOf(p.orderId) ?? Date.now();
    const verdict = this.firstSeen.check(p.identity, p.nonce, p.orderId, observedAt);
    this.track({ ev: "firstSeen", ts: Date.now(), verdict });
    void this.store.saveFirstSeen(this.firstSeen.exportState()).catch(() => {});
    return verdict;
  }

  /** Add local seed edges (root's private trust list). Applied on next refresh. */
  seed(edges: SeedEdge[]): void {
    this.localSeeds.push(...edges);
    this.track({ ev: "seed", ts: Date.now(), count: edges.length });
  }

  async refresh(): Promise<TrustGraphSnapshot> {
    await this.hydrate();
    const t0 = Date.now();
    const res = await fetchGraph({
      pool: this.opts.pool,
      relays: this.opts.relays,
      root: this.opts.root,
      seed: this.localSeeds,
      maxHop: this.opts.maxHop,
      requireHint: this.opts.requireHint,
      maxNodes: this.opts.maxNodes,
      maxOutDegreePerNode: this.opts.maxOutDegreePerNode,
      minEdgeWeight: this.opts.minEdgeWeight,
      deadlineMs: this.opts.deadlineMs,
    });
    for (const a of res.attestations) this.cache.set(`${a.truster}\n${a.d}`, a);
    await this.store.saveAttestations([...this.cache.values()]);
    const snap = this.recompute(res.truncated);
    this.track({ ev: "refresh", ts: Date.now(), nodes: snap.nodes, edges: snap.edges, truncated: res.truncated, ms: Date.now() - t0, relaysQueried: res.relaysQueried.length, hintedNodes: res.hintedNodes });
    return snap;
  }

  /** Rebuild adjacency + scores from the local cache (no network). */
  private recompute(truncated = false): TrustGraphSnapshot {
    const adj = cappedAdjacency([...this.cache.values()], {
      maxOutDegree: this.opts.maxOutDegreePerNode,
      minEdgeWeight: this.opts.minEdgeWeight,
      hardReciprocal: this.opts.hardReciprocal,
    });
    const scores = this.scorer(adj, this.opts.root);
    this.adjacency = adj;
    this.scores = scores;
    this.sortedScores = [...scores.values()].sort((a, b) => a - b);
    const snapshot: TrustGraphSnapshot = {
      root: this.opts.root,
      nodes: countNodes(adj),
      edges: countEdges(adj),
      scores,
      truncated,
      updatedAt: Date.now(),
    };
    this.opts.onUpdate?.(snapshot);
    return snapshot;
  }

  /** Root's own published attestations (excludes local seeds and revoked edges). */
  myAttestations(): Attestation[] {
    return [...this.cache.values()].filter((a) => a.truster === this.opts.root && !a.local && a.weight > 0);
  }

  /** Edges pointing at `identity` (who attests this identity). */
  attestationsTo(identity: string): Attestation[] {
    return [...this.cache.values()].filter((a) => a.trustee === identity && a.weight > 0);
  }

  /** Edges authored by `identity` (whom this identity attests). */
  attestationsBy(identity: string): Attestation[] {
    return [...this.cache.values()].filter((a) => a.truster === identity && a.weight > 0);
  }

  /** Revoked edges (w=0 revisions) currently known in the cache. */
  revokedAttestations(): Attestation[] {
    return [...this.cache.values()].filter((a) => a.weight <= 0);
  }

  /** Trust stats for an identity. */
  stats(identity: string): {
    score: number | undefined;
    percentile: number | undefined;
    received: number;
    given: number;
    revokedReceived: number;
    revokedGiven: number;
  } {
    let received = 0;
    let given = 0;
    let revokedReceived = 0;
    let revokedGiven = 0;
    for (const a of this.cache.values()) {
      if (a.trustee === identity) a.weight > 0 ? received++ : revokedReceived++;
      if (a.truster === identity) a.weight > 0 ? given++ : revokedGiven++;
    }
    return { score: this.scores.get(identity), percentile: this.percentile(identity), received, given, revokedReceived, revokedGiven };
  }

  /**
   * Strongest trust path from root to `identity` (max product of PPR transition
   * probabilities), i.e. "why is this identity trusted". Null if unreachable.
   */
  trustPath(identity: string): { edges: Array<{ from: string; to: string; weight: number }>; score: number } | null {
    if (identity === this.opts.root) return { edges: [], score: 1 };
    const outSum = new Map<string, number>();
    for (const [u, es] of this.adjacency) outSum.set(u, es.reduce((s, e) => s + e.weight, 0));
    const best = new Map<string, number>([[this.opts.root, 1]]);
    const parent = new Map<string, { from: string; weight: number }>();
    const visited = new Set<string>();
    const frontier: string[] = [this.opts.root];
    while (frontier.length > 0) {
      let bi = 0;
      for (let i = 1; i < frontier.length; i++) {
        if ((best.get(frontier[i]!) ?? 0) > (best.get(frontier[bi]!) ?? 0)) bi = i;
      }
      const u = frontier.splice(bi, 1)[0]!;
      if (visited.has(u)) continue;
      visited.add(u);
      if (u === identity) break;
      const sum = outSum.get(u) ?? 0;
      if (sum <= 0) continue;
      for (const e of this.adjacency.get(u) ?? []) {
        const np = (best.get(u) ?? 0) * (e.weight / sum);
        if (np > (best.get(e.to) ?? 0)) {
          best.set(e.to, np);
          parent.set(e.to, { from: u, weight: e.weight });
          frontier.push(e.to);
        }
      }
    }
    if (!parent.has(identity)) return null;
    const edges: Array<{ from: string; to: string; weight: number }> = [];
    let cur = identity;
    while (cur !== this.opts.root) {
      const p = parent.get(cur);
      if (!p) return null;
      edges.unshift({ from: p.from, to: cur, weight: p.weight });
      cur = p.from;
    }
    return { edges, score: best.get(identity) ?? 0 };
  }

  private applyEvent(event: NostrEvent): void {
    const att = parseAttestation(event);
    if (att) this.cache.set(`${att.truster}\n${att.d}`, att);
  }

  private nextCreatedAt(d: string): number {
    const existing = this.cache.get(`${this.opts.root}\n${d}`);
    return Math.max(Math.floor(Date.now() / 1000), (existing?.createdAt ?? 0) + 1);
  }

  private requirePublisher(): EventPublisher {
    if (!this.publisher) throw new Error("TrustGraph: no publisher configured (pass `publisher` or a pool with publish())");
    return this.publisher;
  }

  private async emit(event: NostrEvent, retries?: number): Promise<PublishReport> {
    return publishEvent(this.requirePublisher(), this.opts.relays, event, { retries });
  }

  /** Publish (or update) a root attestation and reflect it locally. */
  async publishAttestation(p: {
    trusterSecretHex: string;
    trustee: string;
    weight: number;
    hint: string;
    context?: string;
    expiration?: number;
    ttlSec?: number;
    retries?: number;
  }): Promise<PublishResult> {
    const context = p.context ?? "market";
    const event = buildAttestation({ ...p, context, createdAt: this.nextCreatedAt(attestationDTag(p.trustee, context)) });
    const report = await this.emit(event, p.retries);
    this.track({ ev: "publish", ts: Date.now(), op: "attest", relayOk: report.relays.filter((r) => r.ok).length, relayFail: report.relays.filter((r) => !r.ok).length });
    if (!report.ok) throw new PublishError("no relay accepted the attestation", report);
    this.applyEvent(event);
    await this.store.saveAttestations([...this.cache.values()]);
    this.recompute();
    return { event, report };
  }

  /** Revoke one root attestation (republish w=0) and reflect it locally. */
  async revokeAttestation(p: { trusterSecretHex: string; trustee: string; hint?: string; context?: string; retries?: number }): Promise<PublishResult> {
    const context = p.context ?? "market";
    const event = buildRevoke({ ...p, context, createdAt: this.nextCreatedAt(attestationDTag(p.trustee, context)) });
    const report = await this.emit(event, p.retries);
    this.track({ ev: "publish", ts: Date.now(), op: "revoke", relayOk: report.relays.filter((r) => r.ok).length, relayFail: report.relays.filter((r) => !r.ok).length });
    if (!report.ok) throw new PublishError("no relay accepted the revoke", report);
    this.applyEvent(event);
    await this.store.saveAttestations([...this.cache.values()]);
    this.recompute();
    return { event, report };
  }

  /** Revoke all of root's published attestations (optionally one context). */
  async revokeAll(p: { trusterSecretHex: string; context?: string; retries?: number }): Promise<PublishResult[]> {
    const mine = this.myAttestations().filter((a) => (p.context ? contextFromDTag(a.d) === p.context : true));
    const base = Math.floor(Date.now() / 1000);
    const out: PublishResult[] = [];
    let i = 0;
    for (const a of mine) {
      const event = buildRevoke({ trusterSecretHex: p.trusterSecretHex, trustee: a.trustee, context: contextFromDTag(a.d), createdAt: Math.max(base + i, a.createdAt + 1) });
      const report = await this.emit(event, p.retries);
      this.track({ ev: "publish", ts: Date.now(), op: "revoke", relayOk: report.relays.filter((r) => r.ok).length, relayFail: report.relays.filter((r) => !r.ok).length });
      if (report.ok) this.applyEvent(event);
      out.push({ event, report });
      i++;
    }
    await this.store.saveAttestations([...this.cache.values()]);
    this.recompute();
    return out;
  }

  /** Publish many root attestations at once. Returns one result per edge. */
  async publishAll(p: {
    trusterSecretHex: string;
    edges: Array<{ trustee: string; weight: number; hint: string; context?: string; expiration?: number; ttlSec?: number }>;
    retries?: number;
  }): Promise<PublishResult[]> {
    const base = Math.floor(Date.now() / 1000);
    const out: PublishResult[] = [];
    let i = 0;
    for (const e of p.edges) {
      const context = e.context ?? "market";
      const event = buildAttestation({ trusterSecretHex: p.trusterSecretHex, ...e, context, createdAt: Math.max(base + i, this.nextCreatedAt(attestationDTag(e.trustee, context))) });
      const report = await this.emit(event, p.retries);
      this.track({ ev: "publish", ts: Date.now(), op: "attest", relayOk: report.relays.filter((r) => r.ok).length, relayFail: report.relays.filter((r) => !r.ok).length });
      if (report.ok) this.applyEvent(event);
      out.push({ event, report });
      i++;
    }
    await this.store.saveAttestations([...this.cache.values()]);
    this.recompute();
    return out;
  }

  /** Refresh now, then periodically, plus a live subscription (orders + attestations). */
  start(p: { intervalMs?: number; live?: boolean } = {}): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), p.intervalMs ?? 60_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
    if (p.live ?? this.opts.live ?? true) this.subscribe();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.liveTimer) {
      clearTimeout(this.liveTimer);
      this.liveTimer = null;
    }
    for (const s of this.subs) s.close();
    this.subs = [];
  }

  /** Live subscription: orders (first-seen) + attestations (graph). */
  private subscribe(): void {
    const pool = this.opts.pool;
    if (!pool.subscribeMany || this.subs.length > 0) return;
    try {
      this.subs.push(pool.subscribeMany(this.opts.relays, { kinds: [NOSTR_ORDER_EVENT_KIND] }, { onevent: (e) => this.onLiveEvent(e) }));
      this.subs.push(pool.subscribeMany(this.opts.relays, { kinds: [ATTESTATION_KIND] }, { onevent: (e) => this.onLiveEvent(e) }));
    } catch {
      // subscription unavailable — polling still runs
    }
  }

  private onLiveEvent(event: NostrEvent): void {
    if (event.kind === NOSTR_ORDER_EVENT_KIND) {
      const orderId = event.tags.find((t) => t[0] === "d")?.[1];
      if (orderId) {
        this.firstSeen.noteOrder(orderId, Date.now());
        void this.store.saveFirstSeen(this.firstSeen.exportState()).catch(() => {});
      }
      this.track({ ev: "order", ts: Date.now() });
      this.opts.onOrderEvent?.(event);
      return;
    }
    if (event.kind === ATTESTATION_KIND) {
      const att = parseAttestation(event);
      if (!att) return;
      if ((this.opts.requireHint ?? true) && !att.hint) return;
      this.cache.set(`${att.truster}\n${att.d}`, att);
      this.scheduleLive();
    }
  }

  /** Debounced persist + recompute after live attestations. */
  private scheduleLive(): void {
    if (this.liveTimer) return;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      void this.store.saveAttestations([...this.cache.values()]).catch(() => {});
      this.recompute();
    }, this.opts.liveDebounceMs ?? 250);
    (this.liveTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Accumulated attestations (for debug/UI). */
  attestations(): Attestation[] {
    return [...this.cache.values()];
  }

  score(identity: string): number | undefined {
    return this.scores.get(identity);
  }

  /** Percentile in [0,1] of a node's score within the graph. */
  percentile(identity: string): number | undefined {
    const s = this.scores.get(identity);
    if (s === undefined || this.sortedScores.length < 2) return undefined;
    let below = 0;
    for (const x of this.sortedScores) if (x < s) below++;
    return below / (this.sortedScores.length - 1);
  }

  /**
   * rating is the gate; PPR only breaks ties and raises the discrepancy flag.
   * `rating` comes from Mostro's kind-38383 `rating` tag (`total_reviews`).
   */
  classify(p: { identity: string | null; rating: { count: number } | null }): TrustBadge {
    if (!p.identity) return { state: "UNRATED", reasons: ["no-identity"] };
    const score = this.scores.get(p.identity);
    if (!p.rating || p.rating.count === 0) {
      const high = (this.percentile(p.identity) ?? 0) >= 0.9 && score !== undefined && score > 0;
      return high
        ? { state: "farm-suspect", score, reasons: ["rating-0", "ppr-top10"] }
        : { state: "UNRATED", score, reasons: ["rating-0"] };
    }
    if (score !== undefined && score > 0) return { state: "도달", score, reasons: [] };
    return { state: "미도달", reasons: [] };
  }
}
