// Social-index (30501) authoring, NIP-02 follow-list authoring, NIP-17
// verification-payload DMs, and reputation-mode disclosure.

import { finalizeEvent } from "nostr-tools/pure";
import { hex } from "@scure/base";
import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { wrapEvent, unwrapEvent } from "nostr-tools/nip17";
import { FOLLOW_LIST_KIND, type EventPublisher, type EventSource } from "./graph.js";
import { publishEvent, type PublishResult } from "./publish.js";

export const SOCIAL_INDEX_KIND = 30501;
export const SOCIAL_INDEX_D = "mostro-order-index";
export const TRUST_GRAPH_TAG = "mostro-trust-graph";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------- kind 30501: social index (my order list) ----------------

export interface SocialIndexEntry {
  order_id: string;
  mostro_pubkey: string;
  relay: string;
}

export function buildSocialIndex(p: {
  identitySecretHex: string;
  entries: SocialIndexEntry[];
  createdAt?: number;
  dTag?: string;
}): NostrEvent {
  return finalizeEvent(
    {
      kind: SOCIAL_INDEX_KIND,
      created_at: p.createdAt ?? nowSec(),
      tags: [["d", p.dTag ?? SOCIAL_INDEX_D], ["y", TRUST_GRAPH_TAG], ["v", "1"]],
      content: JSON.stringify(p.entries),
    },
    hex.decode(p.identitySecretHex),
  );
}

export function parseSocialIndex(event: Pick<NostrEvent, "kind" | "content">): SocialIndexEntry[] | null {
  if (event.kind !== SOCIAL_INDEX_KIND) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: SocialIndexEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.order_id !== "string" || typeof r.mostro_pubkey !== "string" || typeof r.relay !== "string") continue;
    out.push({ order_id: r.order_id, mostro_pubkey: r.mostro_pubkey, relay: r.relay });
  }
  return out;
}

export async function publishSocialIndex(p: {
  pool: EventPublisher;
  relays: string[];
  identitySecretHex: string;
  entries: SocialIndexEntry[];
  createdAt?: number;
  retries?: number;
}): Promise<PublishResult> {
  const event = buildSocialIndex(p);
  const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
  return { event, report };
}

/**
 * Revoke specific orders (republish the list without them), or the whole index
 * when `orderIds` is omitted (republish an empty list).
 */
export async function revokeSocialIndex(p: {
  pool: EventPublisher;
  relays: string[];
  identitySecretHex: string;
  currentEntries?: SocialIndexEntry[];
  orderIds?: string[];
  createdAt?: number;
  retries?: number;
}): Promise<PublishResult> {
  const remaining = p.orderIds
    ? (p.currentEntries ?? []).filter((e) => !p.orderIds!.includes(e.order_id))
    : [];
  const event = buildSocialIndex({ identitySecretHex: p.identitySecretHex, entries: remaining, createdAt: p.createdAt });
  const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
  return { event, report };
}

/** Fetch kind-30501 social indices (latest revision per author). */
export async function fetchSocialIndex(p: {
  pool: EventSource;
  relays: string[];
  authors?: string[];
  timeoutMs?: number;
}): Promise<NostrEvent[]> {
  const filter: Filter = { kinds: [SOCIAL_INDEX_KIND], "#d": [SOCIAL_INDEX_D] };
  if (p.authors && p.authors.length > 0) filter.authors = p.authors;
  let events: NostrEvent[];
  try {
    events = await p.pool.querySync(p.relays, filter, { maxWait: p.timeoutMs ?? 10_000 });
  } catch {
    return [];
  }
  const latest = new Map<string, NostrEvent>();
  for (const e of events) {
    if (e.kind !== SOCIAL_INDEX_KIND) continue;
    const prev = latest.get(e.pubkey);
    if (!prev || e.created_at > prev.created_at) latest.set(e.pubkey, e);
  }
  return [...latest.values()];
}

// ---------------- NIP-02 follow list (kind 3) ----------------

export function buildFollowList(p: {
  secretHex: string;
  follows: string[];
  /** Optional relay hints per pubkey (legacy NIP-02 content map). */
  relays?: Record<string, string>;
  createdAt?: number;
}): NostrEvent {
  return finalizeEvent(
    {
      kind: FOLLOW_LIST_KIND,
      created_at: p.createdAt ?? nowSec(),
      tags: p.follows.map((f) => ["p", f]),
      content: p.relays ? JSON.stringify(p.relays) : "",
    },
    hex.decode(p.secretHex),
  );
}

export async function publishFollowList(p: {
  pool: EventPublisher;
  relays: string[];
  secretHex: string;
  follows: string[];
  contentRelays?: Record<string, string>;
  createdAt?: number;
  retries?: number;
}): Promise<PublishResult> {
  const event = buildFollowList({ secretHex: p.secretHex, follows: p.follows, relays: p.contentRelays, createdAt: p.createdAt });
  const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
  return { event, report };
}

// ---------------- NIP-17 DM: verification payload (§6) ----------------

export interface TrustGraphDmPayload {
  type: "mostro-trust-graph-v1";
  identity_pubkey: string;
  order_id: string;
  mostro_pubkey: string;
  relay: string;
}

export function buildTrustGraphDm(p: {
  senderSecretHex: string;
  recipientPubkey: string;
  payload: TrustGraphDmPayload;
}): NostrEvent {
  return wrapEvent(hex.decode(p.senderSecretHex), { publicKey: p.recipientPubkey }, JSON.stringify(p.payload));
}

export async function sendTrustGraphDm(p: {
  pool: EventPublisher;
  relays: string[];
  senderSecretHex: string;
  recipientPubkey: string;
  payload: TrustGraphDmPayload;
  retries?: number;
}): Promise<PublishResult> {
  const event = buildTrustGraphDm(p);
  const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
  return { event, report };
}

/** Unwrap a NIP-17 gift wrap and parse the verification payload. */
export function parseTrustGraphDm(p: { event: NostrEvent; recipientSecretHex: string }): TrustGraphDmPayload | null {
  let content: string;
  try {
    content = unwrapEvent(p.event, hex.decode(p.recipientSecretHex)).content;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (r.type !== "mostro-trust-graph-v1") return null;
  if (typeof r.identity_pubkey !== "string" || typeof r.order_id !== "string" || typeof r.mostro_pubkey !== "string" || typeof r.relay !== "string") return null;
  return { type: "mostro-trust-graph-v1", identity_pubkey: r.identity_pubkey, order_id: r.order_id, mostro_pubkey: r.mostro_pubkey, relay: r.relay };
}

// ---------------- reputation mode + disclosure (§11) ----------------

export type ReputationMode = "full-privacy" | "reputation" | "public-reputation";

export const PUBLIC_REPUTATION_DISCLOSURE =
  "이 모드를 활성화하면 당신의 Nostr identity가 Mostro 오더와 연결됩니다. 소셜 인덱스 이벤트의 공개 범위를 직접 설정하세요.";

/** Disclosure the client must show when enabling a mode (null = none). */
export function disclosureFor(mode: ReputationMode): string | null {
  return mode === "public-reputation" ? PUBLIC_REPUTATION_DISCLOSURE : null;
}
