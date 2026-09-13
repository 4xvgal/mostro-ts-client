// Attestation authoring: build / publish / revoke (single + all) and NIP-02
// follow-list reads. kind 30500 is addressable, so an edge is keyed by
// (truster, d); revoke = republish the SAME d with w=0 and a later created_at.

import { finalizeEvent } from "nostr-tools/pure";
import { hex } from "@scure/base";
import type { NostrEvent } from "nostr-tools/core";
import { ATTESTATION_KIND, FOLLOW_LIST_KIND, isRelayUrl, type EventPublisher, type EventSource, type Attestation } from "./graph.js";
import { publishEvent, type PublishResult } from "./publish.js";

export const ATTEST_CONTEXT = "market";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Replaceable edge address: one per (context, trustee). */
export function attestationDTag(trustee: string, context = ATTEST_CONTEXT): string {
  return `tg:v1:${context}:${trustee}`;
}

/** Parse the context out of a `d` tag (`tg:v1:<context>:<trustee>`). */
export function contextFromDTag(d: string): string | undefined {
  const m = /^tg:v1:([^:]+):/.exec(d);
  return m ? m[1] : undefined;
}

export interface BuildAttestationParams {
  trusterSecretHex: string;
  trustee: string;
  weight: number;
  /** Relay where the trustee's own attestations live (required for expansion). */
  hint: string;
  context?: string;
  createdAt?: number;
  /** NIP-40 expiration (unix seconds). */
  expiration?: number;
  /** Convenience: expiration = createdAt + ttlSec. */
  ttlSec?: number;
}

/** Build a kind-30500 attestation event. */
export function buildAttestation(p: BuildAttestationParams): NostrEvent {
  const context = p.context ?? ATTEST_CONTEXT;
  const weight = Math.max(0, Math.min(100, Math.round(p.weight)));
  if (weight > 0 && !isRelayUrl(p.hint)) {
    throw new Error(`buildAttestation: a valid relay hint (wss://) is required for a live edge (got ${JSON.stringify(p.hint)})`);
  }
  const createdAt = p.createdAt ?? nowSec();
  const expiresAt = p.expiration ?? (p.ttlSec ? createdAt + p.ttlSec : undefined);
  const tags: string[][] = [["d", attestationDTag(p.trustee, context)], ["p", p.trustee, p.hint], ["w", String(weight)], ["t", context]];
  if (expiresAt) tags.push(["expiration", String(expiresAt)]);
  return finalizeEvent(
    {
      kind: ATTESTATION_KIND,
      created_at: createdAt,
      tags,
      content: "",
    },
    hex.decode(p.trusterSecretHex),
  );
}

/** Build the removal revision (w=0) for an edge. */
export function buildRevoke(p: { trusterSecretHex: string; trustee: string; hint?: string; context?: string; createdAt?: number }): NostrEvent {
  return buildAttestation({
    trusterSecretHex: p.trusterSecretHex,
    trustee: p.trustee,
    weight: 0,
    hint: p.hint ?? "",
    context: p.context,
    createdAt: p.createdAt,
  });
}

export async function publishAttestation(
  p: { pool: EventPublisher; relays: string[]; retries?: number } & BuildAttestationParams,
): Promise<PublishResult> {
  const event = buildAttestation(p);
  const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
  return { event, report };
}

export async function revokeAttestation(p: {
  pool: EventPublisher;
  relays: string[];
  trusterSecretHex: string;
  trustee: string;
  hint?: string;
  context?: string;
  createdAt?: number;
  retries?: number;
}): Promise<PublishResult> {
  const event = buildRevoke(p);
  const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
  return { event, report };
}

/**
 * Revoke many edges. Published sequentially with strictly increasing
 * created_at so each revision replaces the previous one (relays keep latest).
 */
export async function revokeAll(p: {
  pool: EventPublisher;
  relays: string[];
  trusterSecretHex: string;
  attestations: Array<{ trustee: string; hint?: string | null; context?: string; createdAt?: number }>;
  startAt?: number;
  retries?: number;
}): Promise<PublishResult[]> {
  const base = p.startAt ?? nowSec();
  const out: PublishResult[] = [];
  let i = 0;
  for (const a of p.attestations) {
    const createdAt = Math.max(base + i, (a.createdAt ?? 0) + 1);
    const event = buildRevoke({ trusterSecretHex: p.trusterSecretHex, trustee: a.trustee, hint: a.hint ?? undefined, context: a.context, createdAt });
    const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
    out.push({ event, report });
    i++;
  }
  return out;
}

/**
 * Publish many attestations at once. created_at increases per edge so repeated
 * publishes of the same trustee replace cleanly. Returns one result per edge.
 */
export async function publishAll(p: {
  pool: EventPublisher;
  relays: string[];
  trusterSecretHex: string;
  edges: Array<{ trustee: string; weight: number; hint: string; context?: string; expiration?: number; ttlSec?: number }>;
  startAt?: number;
  retries?: number;
}): Promise<PublishResult[]> {
  const base = p.startAt ?? nowSec();
  const out: PublishResult[] = [];
  let i = 0;
  for (const e of p.edges) {
    const event = buildAttestation({ trusterSecretHex: p.trusterSecretHex, ...e, createdAt: base + i });
    const report = await publishEvent(p.pool, p.relays, event, { retries: p.retries });
    out.push({ event, report });
    i++;
  }
  return out;
}

/**
 * Confirm a hint relay actually holds the edge (author's 30500 with the d tag).
 * Untrusted-relay guard: only counts events signed by `truster`.
 */
export async function verifyHintHolds(p: {
  pool: EventSource;
  hint: string;
  truster: string;
  trustee: string;
  context?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!isRelayUrl(p.hint)) return false;
  let events: NostrEvent[];
  try {
    events = await p.pool.querySync([p.hint], { kinds: [ATTESTATION_KIND], authors: [p.truster], "#d": [attestationDTag(p.trustee, p.context)] }, { maxWait: p.timeoutMs ?? 8_000 });
  } catch {
    return false;
  }
  return events.some((e) => e.pubkey === p.truster);
}

/** Audit the hint relay of each edge. Returns per-edge liveness. */
export async function auditHints(p: {
  pool: EventSource;
  attestations: Attestation[];
  timeoutMs?: number;
}): Promise<Array<{ attestation: Attestation; ok: boolean }>> {
  return Promise.all(
    p.attestations.map(async (a) => ({
      attestation: a,
      ok: a.hint ? await verifyHintHolds({ pool: p.pool, hint: a.hint, truster: a.truster, trustee: a.trustee, timeoutMs: p.timeoutMs }) : false,
    })),
  );
}

export async function fetchFollowList(p: {
  pool: EventSource;
  relays: string[];
  pubkey: string;
  timeoutMs?: number;
}): Promise<string[]> {
  let events: NostrEvent[];
  try {
    events = await p.pool.querySync(p.relays, { kinds: [FOLLOW_LIST_KIND], authors: [p.pubkey] }, { maxWait: p.timeoutMs ?? 10_000 });
  } catch {
    return [];
  }
  let latest: NostrEvent | null = null;
  for (const e of events) {
    if (e.pubkey !== p.pubkey) continue; // untrusted relay
    if (!latest || e.created_at > latest.created_at) latest = e;
  }
  if (!latest) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of latest.tags) {
    if (t[0] === "p" && t[1] && !seen.has(t[1])) {
      seen.add(t[1]);
      out.push(t[1]);
    }
  }
  return out;
}
