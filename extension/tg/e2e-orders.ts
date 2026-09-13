// L2 E2E: order binding through a real mostrod (regtest, mostro-core 0.14.6).
//
// For each of the 5 trust-graph nodes: create a sell order whose `pm` field
// carries a Schnorr order-binding token, then fetch the published kind-38383
// events and re-verify the challenge from the ACTUAL tags. Also submits a
// copied token from a fresh identity and checks first-seen rejection (§12).
//
//   MOSTRO_RELAY=ws://localhost:7080 npx tsx extension/tg/e2e-orders.ts

import assert from "node:assert/strict";
import { SimplePool } from "nostr-tools/pool";
import {
  deriveTradeKeys,
  generateMnemonic,
  fetchMostroOrderEvents,
  DmRouter,
  type DerivedKeys,
  type OrderEvent,
} from "../../src/protocol/index.js";
import { infoFromRelay } from "../../test/lib/relay.js";
import { RELAY, RELAYS, FIAT, createSellOrder } from "./e2e-kit.js";
import {
  buildPmToken,
  verifyPmToken,
  parseTgToken,
  canonicalBase,
  extractTokenFromSegments,
  insertToken,
  type TgChallengeInput,
} from "./token.js";
import { FirstSeenTracker } from "./firstSeen.js";

interface NodeSpec {
  label: string;
  fiatAmount: number;
  /** Raw user input; "bank transfer,,zelle" exercises canonicalization. */
  rawPay: string;
}
const NODES: NodeSpec[] = [
  { label: "R", fiatAmount: 10, rawPay: "bank transfer" },
  { label: "B", fiatAmount: 11, rawPay: "bank transfer" },
  { label: "C", fiatAmount: 12, rawPay: "bank transfer" },
  { label: "D", fiatAmount: 13, rawPay: "bank transfer" },
  { label: "E", fiatAmount: 14, rawPay: "bank transfer,,zelle" },
];

function tagValue(event: OrderEvent, name: string): string {
  for (const t of event.tags) if (t[0] === name && t[1] !== undefined) return t[1];
  return "";
}

function tagValues(event: OrderEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name).flatMap((t) => t.slice(1));
}

interface ResolvedOrder {
  orderId: string;
  token: string;
  nonce: Uint8Array;
  input: TgChallengeInput;
}

function resolveOrder(event: OrderEvent): ResolvedOrder | null {
  const ex = extractTokenFromSegments(tagValues(event, "pm"));
  if (!ex) return null;
  const parsed = parseTgToken(ex.token);
  if (!parsed) return null;
  const fa = tagValues(event, "fa");
  const common = {
    mostroPubkey: event.pubkey,
    kind: tagValue(event, "k"),
    fiatCode: tagValue(event, "f"),
    premium: Number(tagValue(event, "premium")),
    basePaymentMethod: ex.base,
  };
  const input: TgChallengeInput =
    fa.length >= 2
      ? { ...common, variant: "v1r", minAmount: Number(fa[0]), maxAmount: Number(fa[1]) }
      : { ...common, fiatAmount: Number(fa[0]) };
  return { orderId: tagValue(event, "d"), token: ex.token, nonce: parsed.nonce, input };
}

async function main() {
  const pool = new SimplePool();
  const mostroPubkey = await infoFromRelay(pool, RELAY);
  if (!mostroPubkey) throw new Error("no mostro info event");
  console.log("mostro:", mostroPubkey);

  const router = new DmRouter({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey, transport: "nip44" });

  // ---- create one sell order per node, pm carries the token ----
  const created = new Map<string, { spec: NodeSpec; identity: DerivedKeys; orderId: string; token: string; pm: string; nonce: Uint8Array }>();
  const tokenOf = new Map<string, { label: string; nonce: Uint8Array }>();
  for (const spec of NODES) {
    const mn = generateMnemonic();
    const identity = deriveTradeKeys(mn, 0);
    const trade = deriveTradeKeys(mn, 1);
    const base = canonicalBase(spec.rawPay);
    const token = buildPmToken(
      { mostroPubkey, kind: "sell", fiatCode: FIAT, premium: 0, basePaymentMethod: base, fiatAmount: spec.fiatAmount },
      identity.secret,
    );
    // Submit through mostrod verbatim (raw empties included) — mostrod splits it.
    const pm = insertToken(spec.rawPay, token);
    const orderId = await createSellOrder({ pool, router, mostroPubkey, identity, trade, pm, fiatAmount: spec.fiatAmount, label: spec.label });
    created.set(spec.label, { spec, identity, orderId, token, pm, nonce: parseTgToken(token)!.nonce });
    tokenOf.set(token, { label: spec.label, nonce: parseTgToken(token)!.nonce });
    console.log(`created ${spec.label} order ${orderId.slice(0, 8)} base="${base}" token=${token.slice(0, 12)}...`);
  }

  // ---- same-instance copy: fresh identity replays R's exact pm token ----
  const r = created.get("R")!;
  await new Promise((res) => setTimeout(res, 1500));
  const impostorMn = generateMnemonic();
  const impostorIdentity = deriveTradeKeys(impostorMn, 0);
  const impostorTrade = deriveTradeKeys(impostorMn, 1);
  const impostorOrderId = await createSellOrder({
    pool,
    router,
    mostroPubkey,
    identity: impostorIdentity,
    trade: impostorTrade,
    pm: r.pm, // verbatim copy of R's bound pm
    fiatAmount: r.spec.fiatAmount,
    label: "impostor",
  });
  console.log(`created impostor order ${impostorOrderId.slice(0, 8)} copying R's pm`);

  // ---- fetch published events ----
  await new Promise((res) => setTimeout(res, 2500));
  const events = await fetchMostroOrderEvents({ pool, relays: RELAYS, mostroPubkeyHex: mostroPubkey });
  const byId = new Map<string, OrderEvent>();
  for (const e of events) byId.set(tagValue(e, "d"), e);

  // ---- verify Schnorr binding against actual tags ----
  const decoy = deriveTradeKeys(generateMnemonic(), 0);
  for (const [label, { identity, orderId }] of created) {
    const event = byId.get(orderId);
    assert.ok(event, `${label}: order event ${orderId} not found`);
    const resolved = resolveOrder(event);
    assert.ok(resolved, `${label}: no single token in pm`);
    assert.equal(verifyPmToken(resolved.input, resolved.token, identity.pubkey), true, `${label}: verify failed`);
    assert.equal(verifyPmToken(resolved.input, resolved.token, decoy.pubkey), false, `${label}: decoy verified`);
    console.log(`  ${label} identity bound OK (base="${resolved.input.basePaymentMethod}")`);
  }

  // ---- first-seen: R's order valid, impostor's copy rejected ----
  const tracker = new FirstSeenTracker();
  const verdicts = new Map<string, "valid" | "invalid">();
  const inCreatedAtOrder = [...events].sort((a, b) => a.created_at - b.created_at);
  for (const event of inCreatedAtOrder) {
    const resolved = resolveOrder(event);
    if (!resolved) continue;
    const owner = tokenOf.get(resolved.token);
    if (!owner) continue; // not ours
    const verdict = tracker.check(created.get(owner.label)!.identity.pubkey, resolved.nonce, resolved.orderId, event.created_at);
    verdicts.set(resolved.orderId, verdict);
  }
  assert.equal(verdicts.get(r.orderId), "valid", "R's original order must be valid");
  assert.equal(verdicts.get(impostorOrderId), "invalid", "copied token on a second order must be rejected");
  for (const [label, { orderId }] of created) {
    assert.equal(verdicts.get(orderId), "valid", `${label} order must be valid`);
  }
  console.log("  first-seen: R valid, impostor invalid");

  // The copied token still resolves to R by Schnorr — that's the soft-binding
  // limit (§16): only first-seen rejects it.
  const impostorEvent = byId.get(impostorOrderId)!;
  const impostorResolved = resolveOrder(impostorEvent)!;
  assert.equal(verifyPmToken(impostorResolved.input, impostorResolved.token, r.identity.pubkey), true);
  assert.equal(verifyPmToken(impostorResolved.input, impostorResolved.token, impostorIdentity.pubkey), false);

  pool.close(RELAYS);
  console.log("L2 ORDER-BINDING E2E PASS");
}

main().catch((err) => {
  console.error("L2 E2E FAIL:", err);
  process.exit(1);
});
