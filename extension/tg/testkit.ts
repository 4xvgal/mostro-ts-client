// Shared test utilities for the trust-graph extension.

import type { NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { ATTESTATION_KIND, FOLLOW_LIST_KIND, type EventSource } from "./graph.js";

export const BOOT = "wss://boot.example";
export const HINT = "wss://hint.example";

/** Build a kind-30500 attestation event. */
export function att(truster: string, trustee: string, hint?: string, weight = 50): NostrEvent {
  const p: string[] = ["p", trustee];
  if (hint !== undefined) p.push(hint);
  return {
    id: `${truster}->${trustee}:${hint ?? "none"}`,
    pubkey: truster,
    created_at: 100,
    kind: ATTESTATION_KIND,
    tags: [["d", `tg:v1:market:${trustee}`], p, ["w", String(weight)]],
    content: "",
    sig: "00",
  } as unknown as NostrEvent;
}

/** Build a NIP-02 follow-list (kind 3) event. */
export function followListEvent(pubkey: string, follows: string[], createdAt = 100): NostrEvent {
  return {
    id: `follow:${pubkey}:${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: FOLLOW_LIST_KIND,
    tags: follows.map((f) => ["p", f]),
    content: "",
    sig: "00",
  } as unknown as NostrEvent;
}

/** Build a kind-38383 order event (for live/first-seen tests). */
export function orderEvent(orderId: string, createdAt = 100): NostrEvent {
  return {
    id: `order:${orderId}`,
    pubkey: "mostro",
    created_at: createdAt,
    kind: 38383,
    tags: [["d", orderId]],
    content: "",
    sig: "00",
  } as unknown as NostrEvent;
}

/**
 * In-memory relay stub. `honorAuthors: false` (default) returns every event on
 * the queried relays regardless of the filter, so callers' untrusted-relay
 * guards get exercised.
 */
export class StubEventSource implements EventSource {
  calls: Array<{ relays: string[]; authors: string[] }> = [];
  published: NostrEvent[] = [];
  constructor(
    public store: Map<string, NostrEvent[]> = new Map(),
    public honorAuthors = false,
  ) {}

  async querySync(relays: string[], filter: Filter): Promise<NostrEvent[]> {
    const authors = (filter.authors as string[]) ?? [];
    this.calls.push({ relays, authors });
    const out: NostrEvent[] = [];
    for (const r of relays) {
      for (const e of this.store.get(r) ?? []) {
        if (this.honorAuthors && !authors.includes(e.pubkey)) continue;
        out.push(e);
      }
    }
    return out;
  }

  /** EventPublisher stub: records published events (one promise per relay). */
  publish(relays: string[], event: NostrEvent): Array<Promise<string>> {
    this.published.push(event);
    return relays.map(() => Promise.resolve(event.id));
  }

  private handlers: Array<(e: NostrEvent) => void> = [];

  subscribeMany(_relays: string[], _filter: Filter, params: { onevent: (e: NostrEvent) => void }): { close(): void } {
    const h = params.onevent;
    this.handlers.push(h);
    return { close: () => void (this.handlers = this.handlers.filter((x) => x !== h)) };
  }

  /** Push an event to every live subscriber. */
  emit(event: NostrEvent): void {
    for (const h of [...this.handlers]) h(event);
  }

  get subCount(): number {
    return this.handlers.length;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
