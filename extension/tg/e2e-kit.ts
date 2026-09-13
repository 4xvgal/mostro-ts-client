// Shared helpers for the regtest E2E scripts.

import { SimplePool } from "nostr-tools/pool";
import type { NostrEvent } from "nostr-tools/core";
import {
  buildNewOrder,
  getOrder,
  sendDm,
  unwrapMessageNip44,
  type DerivedKeys,
  type DmRouter,
} from "../../src/protocol/index.js";
import { buildAttestation } from "./attest.js";

export const RELAY = process.env.MOSTRO_RELAY ?? "ws://localhost:7080";
export const RELAYS = [RELAY];
export const FIAT = "USD";

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms))]);
}

/** Create a sell order through a real mostrod; returns the server order id. */
export async function createSellOrder(params: {
  pool: SimplePool;
  router: DmRouter;
  mostroPubkey: string;
  identity: DerivedKeys;
  trade: DerivedKeys;
  pm: string;
  fiatAmount: number;
  label: string;
}): Promise<string> {
  const { pool, router, mostroPubkey, identity, trade, pm, fiatAmount, label } = params;
  const { message } = buildNewOrder(
    { lastTradeIndex: null },
    { kind: "sell", fiatCode: FIAT, fiatAmount, paymentMethod: pm, expirationDays: 1 },
  );
  const wait = router.waitForDm(trade.secret);
  await sendDm({ pool, relays: RELAYS, identitySecretHex: identity.secret, tradeSecretHex: trade.secret, receiverPubkeyHex: mostroPubkey, message, router });
  const reply = await withTimeout(wait, 15_000, `${label} order reply`);
  const ow = unwrapMessageNip44({ event: { kind: reply.kind, pubkey: reply.pubkey, content: reply.content }, receiverSecretHex: trade.secret });
  if (!ow) throw new Error(`${label}: reply did not decrypt`);
  const order = getOrder(ow.message.value);
  if (!order?.id) throw new Error(`${label}: no order id in reply`);
  return order.id;
}

/** Sign a kind-30500 attestation from `from` to `to`. */
export function attestationEvent(
  from: DerivedKeys,
  to: DerivedKeys,
  opts: { weight: number; hint?: string | null; context?: string; createdAt?: number },
): NostrEvent {
  return buildAttestation({
    trusterSecretHex: from.secret,
    trustee: to.pubkey,
    weight: opts.weight,
    hint: opts.hint ?? RELAY,
    context: opts.context,
    createdAt: opts.createdAt,
  });
}
