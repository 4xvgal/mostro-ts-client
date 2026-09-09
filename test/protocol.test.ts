import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VER,
  NOSTR_ORDER_EVENT_KIND,
  MAX_RATING,
  MIN_RATING,
  Action,
  actionFromString,
  Kind,
  kindFromString,
  Status,
  statusFromString,
  CantDoReason,
  DisputeStatus,
  disputeStatusFromString,
  Transport,
  transportFromString,
  transportEventKind,
  transportProtocolVersion,
  newSmallOrder,
  newOrderMessage,
  newRestoreMessage,
  cantDoMessage,
  verifyMessage,
  verifyMessageKind,
  getPaymentRequest,
  getAmount,
  getRating,
  getOrder,
  serializeMessage,
  deserializeMessage,
  checkFiatAmount,
  checkAmount,
  checkZeroAmountWithPremium,
  checkRangeOrderLimits,
  checkFiatCurrency,
  newPeer,
  updateRating,
} from "../src/protocol/index.js";

// ---------------------------------------------------------------------------
// Constants & enums
// ---------------------------------------------------------------------------

test("constants match mostro-core prelude", () => {
  assert.equal(PROTOCOL_VER, 2);
  assert.equal(NOSTR_ORDER_EVENT_KIND, 38383);
  assert.equal(MAX_RATING, 5);
  assert.equal(MIN_RATING, 1);
});

test("kind parses kebab-case, case-insensitive", () => {
  assert.equal(kindFromString("buy"), Kind.Buy);
  assert.equal(kindFromString("SELL"), Kind.Sell);
  assert.equal(kindFromString("bogus"), null);
});

test("status kebab-case roundtrip", () => {
  assert.equal(Status.WaitingMakerBond, "waiting-maker-bond");
  assert.equal(Status.SettledHoldInvoice, "settled-hold-invoice");
  assert.equal(statusFromString("waiting-taker-bond"), Status.WaitingTakerBond);
  assert.equal(statusFromString("cooperatively-canceled"), Status.CooperativelyCanceled);
  assert.equal(statusFromString("InProgress"), null);
  assert.equal(statusFromString("in-progress"), Status.InProgress);
});

test("action kebab-case roundtrip", () => {
  assert.equal(Action.NewOrder, "new-order");
  assert.equal(Action.PayBondInvoice, "pay-bond-invoice");
  assert.equal(Action.CooperativeCancelInitiatedByPeer, "cooperative-cancel-initiated-by-peer");
  assert.equal(actionFromString("rate-user"), Action.RateUser);
  assert.equal(actionFromString("bogus"), null);
});

test("cant-do reason snake_case", () => {
  assert.equal(CantDoReason.NotAllowedByStatus, "not_allowed_by_status");
  assert.equal(CantDoReason.OutOfRangeFiatAmount, "out_of_range_fiat_amount");
});

test("dispute status kebab-case", () => {
  assert.equal(disputeStatusFromString("seller-refunded"), DisputeStatus.SellerRefunded);
  assert.equal(disputeStatusFromString("nope"), null);
});

test("transport parse + kind + version", () => {
  assert.equal(transportFromString("nip44"), Transport.Nip44Direct);
  assert.equal(transportFromString("gift-wrap"), Transport.GiftWrap);
  assert.equal(transportFromString("dual"), null);
  assert.equal(transportEventKind(Transport.Nip44Direct), 14);
  assert.equal(transportEventKind(Transport.GiftWrap), 1059);
  assert.equal(transportProtocolVersion(Transport.Nip44Direct), 2);
  assert.equal(transportProtocolVersion(Transport.GiftWrap), 1);
});

// ---------------------------------------------------------------------------
// Wire round-trip against mostro-core test vectors
// ---------------------------------------------------------------------------

// sample_message from mostro-core src/order.rs test_order_message
const NEW_ORDER_SAMPLE =
  '{"order":{"version":2,"id":"308e1272-d5f4-47e6-bd97-3504baea9c23","request_id":1,"trade_index":2,"action":"new-order","payload":{"order":{"id":"308e1272-d5f4-47e6-bd97-3504baea9c23","kind":"sell","status":"pending","amount":100,"fiat_code":"eur","fiat_amount":100,"payment_method":"SEPA,Bank transfer","premium":1,"created_at":1627371434}}}}';

test("new-order wire roundtrip matches serde semantics", () => {
  const msg = deserializeMessage(NEW_ORDER_SAMPLE);
  assert.ok(verifyMessage(msg));
  assert.equal(msg.variant, "order");
  const kind = msg.value;
  assert.equal(kind.version, 2);
  assert.equal(kind.id, "308e1272-d5f4-47e6-bd97-3504baea9c23");
  assert.equal(kind.request_id, 1);
  assert.equal(kind.trade_index, 2);
  assert.equal(kind.action, "new-order");

  const order = getOrder(kind);
  assert.ok(order);
  assert.equal(order.kind, "sell");
  assert.equal(order.status, "pending");
  assert.equal(order.fiat_code, "eur");
  assert.equal(order.payment_method, "SEPA,Bank transfer");
  assert.equal(order.premium, 1);
  assert.equal(order.created_at, 1627371434);

  // serde emits nulls for min/max/expires_at (no skip_serializing_if),
  // omits buyer_trade_pubkey/seller_trade_pubkey/buyer_invoice when null.
  const json = serializeMessage(msg);
  assert.ok(json.includes('"min_amount":null'));
  assert.ok(json.includes('"max_amount":null'));
  assert.ok(json.includes('"expires_at":null'));
  assert.ok(!json.includes("buyer_trade_pubkey"));
  assert.ok(!json.includes("buyer_invoice"));

  // Round-trip stability: deserialize(serialize(x)) == x
  const again = deserializeMessage(json);
  assert.deepEqual(again.value, msg.value);
});

test("payment_request wire roundtrip", () => {
  const sample =
    '{"order":{"version":2,"id":"308e1272-d5f4-47e6-bd97-3504baea9c23","request_id":1,"trade_index":3,"action":"pay-invoice","payload":{"payment_request":[{"id":"308e1272-d5f4-47e6-bd97-3504baea9c23","kind":"sell","status":"waiting-payment","amount":100,"fiat_code":"eur","fiat_amount":100,"payment_method":"Face to face","premium":1,"created_at":1627371434},"lnbcrt78510n1pj59wmepp50677g8tffdqa2p8882y0x6newny5vtz0hjuyngdwv226nanv4uzsdqqcqzzsxqyz5vqsp5skn973360gp4yhlpmefwvul5hs58lkkl3u3ujvt57elmp4zugp4q9qyyssqw4nzlr72w28k4waycf27qvgzc9sp79sqlw83j56txltz4va44j7jda23ydcujj9y5k6k0rn5ms84w8wmcmcyk5g3mhpqepf7envhdccp72nz6e",null]}}}';
  const msg = deserializeMessage(sample);
  assert.ok(verifyMessage(msg));
  const pr = msg.value.payload;
  assert.ok(pr && pr.variant === "payment_request");
  assert.equal(pr.value[0]?.id, "308e1272-d5f4-47e6-bd97-3504baea9c23");
  assert.ok(pr.value[1].startsWith("lnbcrt78510n1"));
  assert.equal(pr.value[2], null);
  // mostro-core get_payment_request excludes pay-invoice (only
  // take-sell / add-invoice / add-bond-invoice / new-order).
  assert.equal(getPaymentRequest(msg.value), null);
});

test("peer payload roundtrip (with and without reputation)", () => {
  const peer = newPeer("npub1testjsf0runcqdht5apkfcalajxkf8txdxqqk5kgm0agc38ke4vsfsgzf8", {
    rating: 4.5,
    reviews: 10,
    operating_days: 30,
  });
  const msg = newOrderMessage(
    "308e1272-d5f4-47e6-bd97-3504baea9c23",
    1,
    2,
    "fiat-sent-ok",
    { variant: "peer", value: peer },
  );
  assert.ok(verifyMessage(msg));
  const json = serializeMessage(msg);
  const back = deserializeMessage(json);
  assert.deepEqual(back.value, msg.value);
});

test("cant-do payload roundtrip for every reason", () => {
  const reasons = Object.values(CantDoReason);
  for (const reason of reasons) {
    const msg = cantDoMessage(null, null, { variant: "cant_do", value: reason });
    assert.ok(verifyMessage(msg));
    const back = deserializeMessage(serializeMessage(msg));
    assert.equal(back.value.payload?.value, reason);
  }
  const none = cantDoMessage(null, null, { variant: "cant_do", value: null });
  const back = deserializeMessage(serializeMessage(none));
  assert.equal(back.value.payload?.value, null);
});

test("verify() matrix", () => {
  const uuid = "308e1272-d5f4-47e6-bd97-3504baea9c23";
  const order = newSmallOrder({
    kind: Kind.Sell,
    status: Status.Pending,
    amount: 100,
    fiat_code: "eur",
    fiat_amount: 100,
    payment_method: "SEPA",
    premium: 1,
  });

  // NewOrder requires Order payload.
  assert.ok(verifyMessageKind(newOrderMessage(uuid, 1, 2, "new-order", { variant: "order", value: order }).value));
  assert.ok(!verifyMessageKind(newOrderMessage(uuid, 1, 2, "new-order", null).value));
  assert.ok(!verifyMessageKind(newOrderMessage(uuid, 1, 2, "new-order", { variant: "amount", value: 5 }).value));

  // PayInvoice requires id + PaymentRequest payload.
  assert.ok(
    verifyMessageKind(
      newOrderMessage(uuid, 1, 3, "pay-invoice", {
        variant: "payment_request",
        value: [order, "lnbcrt1", null],
      }).value,
    ),
  );
  assert.ok(
    !verifyMessageKind(newOrderMessage(null, 1, 3, "pay-invoice", { variant: "payment_request", value: [order, "lnbcrt1", null] }).value),
  );

  // TakeSell/TakeBuy: id required, payload not bond.
  assert.ok(verifyMessageKind(newOrderMessage(uuid, 1, 3, "take-sell", null).value));
  assert.ok(!verifyMessageKind(newOrderMessage(null, 1, 3, "take-sell", null).value));
  assert.ok(
    !verifyMessageKind(
      newOrderMessage(uuid, 1, 3, "take-sell", { variant: "bond_resolution", value: { slash_seller: true, slash_buyer: false } }).value,
    ),
  );

  // RestoreSession requires null payload.
  assert.ok(verifyMessageKind(newRestoreMessage(null).value));
  assert.ok(!verifyMessageKind(newRestoreMessage({ variant: "amount", value: 1 }).value));

  // RateUser requires RatingUser payload; range 1..=5 enforced in getRating.
  assert.ok(verifyMessageKind(newOrderMessage(uuid, 1, 3, "rate-user", { variant: "rating_user", value: 5 }).value));
  assert.ok(!verifyMessageKind(newOrderMessage(uuid, 1, 3, "rate-user", null).value));
  assert.ok(verifyMessageKind(newOrderMessage(uuid, 1, 3, "rate-user", { variant: "rating_user", value: 0 }).value));
  assert.throws(() => getRating(newOrderMessage(uuid, 1, 3, "rate-user", { variant: "rating_user", value: 0 }).value));
  assert.equal(getRating(newOrderMessage(uuid, 1, 3, "rate-user", { variant: "rating_user", value: 4 }).value), 4);

  // AdminSettle/AdminCancel: id + null or BondResolution.
  assert.ok(verifyMessageKind(newOrderMessage(uuid, 1, null, "admin-settle", null).value));
  assert.ok(
    verifyMessageKind(
      newOrderMessage(uuid, 1, null, "admin-cancel", { variant: "bond_resolution", value: { slash_seller: true, slash_buyer: true } }).value,
    ),
  );
  assert.ok(!verifyMessageKind(newOrderMessage(null, 1, null, "admin-settle", null).value));
});

test("getAmount reads amount override from take messages", () => {
  const uuid = "308e1272-d5f4-47e6-bd97-3504baea9c23";
  const kind = newOrderMessage(uuid, 1, 3, "take-buy", { variant: "amount", value: 50000 }).value;
  assert.equal(getAmount(kind), 50000);
  const pr = newOrderMessage(uuid, 1, 3, "take-sell", {
    variant: "payment_request",
    value: [null, "lnbcrt1", 75000],
  }).value;
  assert.equal(getAmount(pr), 75000);
});

test("SmallOrder validation helpers", () => {
  const good = newSmallOrder({ amount: 100000, fiat_code: "VES", fiat_amount: 500, payment_method: "Bank", premium: 0 });
  assert.equal(checkFiatAmount(good), null);
  assert.equal(checkAmount(good), null);
  assert.equal(checkZeroAmountWithPremium(good), null);

  const badFiat = newSmallOrder({ amount: 100, fiat_code: "VES", fiat_amount: 0, payment_method: "Bank", premium: 1 });
  assert.equal(checkFiatAmount(badFiat), "invalid_amount");

  const bothSet = newSmallOrder({ amount: 100, fiat_code: "VES", fiat_amount: 500, payment_method: "Bank", premium: 1 });
  assert.equal(checkZeroAmountWithPremium(bothSet), "invalid_parameters");

  const range = newSmallOrder({ amount: 0, fiat_code: "USD", min_amount: 100, max_amount: 200, fiat_amount: 150, payment_method: "SEPA", premium: 0 });
  assert.deepEqual(checkRangeOrderLimits(range), [100, 200]);

  const badRange = newSmallOrder({ amount: 0, fiat_code: "USD", min_amount: 200, max_amount: 100, fiat_amount: 150, payment_method: "SEPA", premium: 0 });
  assert.equal(checkRangeOrderLimits(badRange), "invalid_amount");

  const fixedRange = newSmallOrder({ amount: 100, fiat_code: "USD", min_amount: 100, max_amount: 200, fiat_amount: 150, payment_method: "SEPA", premium: 0 });
  assert.equal(checkRangeOrderLimits(fixedRange), "invalid_amount");

  assert.equal(checkFiatCurrency(good, ["USD", "EUR"]), "invalid_fiat_currency");
  assert.equal(checkFiatCurrency(good, ["VES"]), null);
  assert.equal(checkFiatCurrency(good, []), null);
});

test("updateRating matches mostro-core User::update_rating", () => {
  let s = { total_reviews: 0, total_rating: 0, last_rating: 0, max_rating: 0, min_rating: 0 };
  s = updateRating(5, s);
  assert.equal(s.total_reviews, 1);
  assert.equal(s.total_rating, 2.5); // 5 / 2 (first-vote weight 1/2)
  assert.equal(s.max_rating, 5);
  assert.equal(s.min_rating, 5);
  s = updateRating(3, s);
  assert.equal(s.total_reviews, 2);
  assert.equal(s.total_rating, 2.5 + (5 - 2.5) / 2); // old + (last - old)/reviews
  assert.equal(s.min_rating, 3);
  assert.equal(s.last_rating, 3);
});