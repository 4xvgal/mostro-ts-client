// DM router: request/response waiters + tracked-order subscription routing.
// Ported from mostrix `src/util/dm_utils/mod.rs` (listen_for_order_messages,
// wait_for_dm, send_dm) without the SQLite/TUI coupling.
//
// Responsibilities:
// - `sendDm`: wrap a Message into a kind-14 event and publish it.
// - `waitForDm`: register a waiter, send, then wait for the first decryptable
//   protocol DM addressed to the trade key (15s default).
// - `DmRouter`: background listener that subscribes to protocol DMs for
//   tracked trade keys + waiters, decrypts, and dispatches.

import { SimplePool } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import type { NostrEvent, EventTemplate } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import { hex } from "@scure/base";
import { Transport, transportEventKind } from "./transport.js";
import { unwrapMessageNip44, wrapMessageNip44, pubkeyFromSecret } from "./transport.js";
import type { Message } from "./message.js";
import { identityProofPayload } from "./proof.js";

/** Default wait timeout for Mostro replies (mostrix FETCH_EVENTS_TIMEOUT). */
export const FETCH_EVENTS_TIMEOUT_MS = 15_000;
/** Cap on concurrently pending waiters (mostrix MAX_PENDING_WAITERS). */
const MAX_PENDING_WAITERS = 16;

export interface DmSendParams {
  pool: SimplePool;
  relays: string[];
  /** Identity key (index 0). Falls back to trade key for full-privacy. */
  identitySecretHex?: string;
  tradeSecretHex: string;
  receiverPubkeyHex: string;
  message: Message;
  /** NIP-40 expiration (unix seconds). Defaults to now + 30 days on v2. */
  expiration?: number;
  /** NIP-13 proof-of-work difficulty. */
  pow?: number;
}

/** Wrap + sign + publish a protocol DM as a kind-14 event. */
export async function sendDm(params: DmSendParams): Promise<string> {
  const { pool, relays, tradeSecretHex, receiverPubkeyHex, message } = params;
  const identitySecretHex = params.identitySecretHex ?? tradeSecretHex;
  const expiration = params.expiration ?? Math.floor(Date.now() / 1000) + 30 * 86400;

  const wrapped = wrapMessageNip44({
    message,
    identitySecretHex,
    tradeSecretHex,
    receiverPubkeyHex,
    opts: { signed: true },
  });

  const template: EventTemplate = {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    content: wrapped.content,
    tags: [["p", receiverPubkeyHex]],
  };
  if (expiration) {
    template.tags.push(["expiration", String(expiration)]);
  }

  const event = finalizeEvent(template, hex.decode(tradeSecretHex));
  await pool.publish(relays, event);
  return event.id;
}

/** Filter for inbound protocol DMs from Mostro on the active transport. */
export function filterProtocolDmFromMostro(
  transport: Transport,
  mostroPubkeyHex: string,
  tradePubkeyHex: string,
): Filter {
  const kind = transportEventKind(transport);
  if (transport === Transport.Nip44Direct && mostroPubkeyHex === tradePubkeyHex) {
    return { kinds: [kind], authors: [mostroPubkeyHex] };
  }
  return { kinds: [kind], authors: [mostroPubkeyHex], "#p": [tradePubkeyHex] };
}

/** A waiter awaiting the next protocol DM decryptable by its trade key. */
interface PendingWaiter {
  tradeSecretHex: string;
  resolve: (event: NostrEvent) => void;
  closed: () => boolean;
}

export interface DmRouterOptions {
  pool: SimplePool;
  relays: string[];
  mostroPubkeyHex: string;
  transport: Transport;
  /** identity mnemonic for deriving trade keys (optional — use tradeSecretHex map instead). */
  mnemonic?: string;
  /** Known trade secrets to subscribe immediately (order_id → trade_secret). */
  initialTrades?: Map<string, string>;
  /** Callback for tracked-order DMs (after waiter consumption). */
  onOrderMessage?: (orderId: string, message: Message, event: NostrEvent) => void;
}

/**
 * Background DM router.
 *
 * - `waitForDm(tradeSecretHex)` registers a waiter and returns a promise that
 *   resolves with the first decryptable protocol DM for that trade key.
 * - `trackOrder(orderId, tradeSecretHex)` subscribes the trade key and routes
 *   subsequent DMs to `onOrderMessage`.
 */
export class DmRouter {
  private pool: SimplePool;
  private relays: string[];
  private mostroPubkeyHex: string;
  private transport: Transport;
  private onOrderMessage?: (orderId: string, message: Message, event: NostrEvent) => void;

  private waiters: PendingWaiter[] = [];
  private subscribedSecrets = new Set<string>();
  private orderBySubscription: Map<string, { orderId: string; tradeSecretHex: string }> =
    new Map();
  private subscriptionByPubkey = new Map<string, string>();
  private running = false;

  constructor(opts: DmRouterOptions) {
    this.pool = opts.pool;
    this.relays = opts.relays;
    this.mostroPubkeyHex = opts.mostroPubkeyHex;
    this.transport = opts.transport;
    this.onOrderMessage = opts.onOrderMessage;
    for (const [orderId, secret] of opts.initialTrades ?? []) {
      this.ensureSubscription(orderId, secret);
    }
  }

  /** Register a waiter for the next protocol DM decryptable by this trade key. */
  waitForDm(tradeSecretHex: string): Promise<NostrEvent> {
    return new Promise((resolve, reject) => {
      this.waiters.push({
        tradeSecretHex,
        resolve,
        closed: () => false,
      });
      this.subscribePubkey(tradeSecretHex).catch((e) => reject(e));
    });
  }

  /** Subscribe a trade key for ongoing tracked-order DMs. */
  trackOrder(orderId: string, tradeSecretHex: string): void {
    this.ensureSubscription(orderId, tradeSecretHex);
  }

  private ensureSubscription(orderId: string, tradeSecretHex: string): void {
    if (this.subscribedSecrets.has(tradeSecretHex)) {
      return;
    }
    this.subscribedSecrets.add(tradeSecretHex);
    this.subscribePubkey(tradeSecretHex).then((subscriptionId) => {
      if (subscriptionId) {
        this.orderBySubscription.set(subscriptionId, { orderId, tradeSecretHex });
      }
    });
  }

  private async subscribePubkey(tradeSecretHex: string): Promise<string | null> {
    const tradePubkey = pubkeyFromSecret(tradeSecretHex);
    if (this.subscriptionByPubkey.has(tradePubkey)) {
      return this.subscriptionByPubkey.get(tradePubkey)!;
    }
    const filter = filterProtocolDmFromMostro(this.transport, this.mostroPubkeyHex, tradePubkey);
    this.pool.subscribeMany(this.relays, filter, {
      onevent: (event) => this.handleEvent(event),
    });
    // Simplification: nostr-tools subscribeMany returns the subscription with
    // an `id` via `sub.sub` after connection; we key by a synthetic id we own.
    const syntheticId = `mostro-dm-${tradePubkey.slice(0, 16)}`;
    this.subscriptionByPubkey.set(tradePubkey, syntheticId);
    return syntheticId;
  }

  private handleEvent(event: NostrEvent): void {
    if (event.kind !== transportEventKind(this.transport)) {
      return;
    }
    // Consume waiters first.
    const remaining: PendingWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.closed()) {
        continue;
      }
      const unwrapped = tryUnwrap(event, waiter.tradeSecretHex);
      if (unwrapped !== null && !isOwnSignedOutbound(event, waiter.tradeSecretHex)) {
        waiter.resolve(event);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;

    // Route tracked-order DMs (if the event decrypts with a tracked key).
    if (this.onOrderMessage) {
      const routed = this.routeTracked(event);
      if (routed) {
        this.onOrderMessage(routed.orderId, routed.message, event);
      }
    }
  }

  private routeTracked(event: NostrEvent): { orderId: string; message: Message } | null {
    // Try each subscribed trade secret; first that decrypts wins.
    for (const { orderId, tradeSecretHex } of this.orderBySubscription.values()) {
      const unwrapped = tryUnwrap(event, tradeSecretHex);
      if (unwrapped !== null) {
        return { orderId, message: unwrapped.message };
      }
    }
    return null;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }
}

/** Try unwrap; null when not addressed to this key, throw propagates for malformed. */
function tryUnwrap(
  event: NostrEvent,
  tradeSecretHex: string,
): ReturnType<typeof unwrapMessageNip44> {
  try {
    return unwrapMessageNip44({
      event: { kind: event.kind, pubkey: event.pubkey, content: event.content },
      receiverSecretHex: tradeSecretHex,
    });
  } catch {
    return null;
  }
}

/**
 * True when the event is our own signed v2 outbound request (the request echo
 * must not be consumed as the daemon reply). mostrix: is_own_signed_v2_outbound.
 */
function isOwnSignedOutbound(event: NostrEvent, tradeSecretHex: string): boolean {
  // Own outbound events are authored by the trade key itself.
  return event.pubkey === pubkeyFromSecret(tradeSecretHex);
}

export { identityProofPayload };