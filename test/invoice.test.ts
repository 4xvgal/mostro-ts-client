import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyInvoice,
  isProbablyValidBolt11,
  invoicePayload,
  buildInvoiceMessage,
  handleAddInvoiceResponse,
  handleAddBondInvoiceResponse,
  handleTakeOrderResponse,
  bolt11AmountMsat,
  bolt11Timestamp,
} from "../src/protocol/index.js";
import type { MessageKind } from "../src/protocol/index.js";

const UUID = "308e1272-d5f4-47e6-bd97-3504baea9c23";

test("classifyInvoice detects bolt11 / lnurl / ln-address", () => {
  assert.equal(classifyInvoice("lnbcrt1pj59wme"), "bolt11");
  assert.equal(classifyInvoice("lntb1abc"), "bolt11");
  assert.equal(classifyInvoice("lnurl1dp68gurn8ghj7empd3cx"), "lnurl");
  assert.equal(classifyInvoice("user@domain.com"), "ln-address");
  assert.equal(classifyInvoice("garbage"), null);
});

test("bolt11 heuristic rejects garbage", () => {
  assert.ok(isProbablyValidBolt11("lnbcrt78510n1pj59wmepp50677g"));
  assert.ok(!isProbablyValidBolt11("short"));
  assert.ok(!isProbablyValidBolt11("garbage-string-here"));
});

test("invoicePayload builds PaymentRequest for recognized kinds", () => {
  const bolt = invoicePayload("lnbcrt78510n1pj59wmepp50677g");
  assert.deepEqual(bolt, {
    variant: "payment_request",
    value: [null, "lnbcrt78510n1pj59wmepp50677g", null],
  });

  const lnaddr = invoicePayload("user@domain.com");
  assert.deepEqual(lnaddr?.value[1], "user@domain.com");

  assert.equal(invoicePayload("garbage"), null);
});

test("buildInvoiceMessage builds verified AddInvoice", () => {
  const msg = buildInvoiceMessage({
    orderId: UUID,
    requestId: 5,
    action: "add-invoice",
    invoice: "lnbcrt78510n1pj59wmepp50677g",
  });
  assert.equal(msg.value.action, "add-invoice");
  assert.equal(msg.value.id, UUID);
  assert.equal(msg.value.payload?.variant, "payment_request");

  assert.throws(
    () =>
      buildInvoiceMessage({
        orderId: UUID,
        requestId: 5,
        action: "add-invoice",
        invoice: "not-an-invoice",
      }),
    /Invalid invoice/,
  );
});

test("bolt11AmountMsat decodes multipliers", () => {
  assert.equal(bolt11AmountMsat("lnbc11qqq"), 1e11); // 1 BTC
  assert.equal(bolt11AmountMsat("lnbc2500u1qqq"), 250_000_000); // 2500 µBTC
  assert.equal(bolt11AmountMsat("lnbc1m1qqq"), 100_000_000); // 1 mBTC
  assert.equal(bolt11AmountMsat("lnbc2500n1qqq"), 250_000); // 2500 nBTC
  assert.equal(bolt11AmountMsat("lnbcrt78510n1pj59wmepp50677g"), 7_851_000);
  assert.equal(bolt11AmountMsat("lnbc1qqq"), null); // amountless
  assert.equal(bolt11AmountMsat("garbage"), null);
});

test("bolt11Timestamp decodes the 7-char base32 timestamp", () => {
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const encode7 = (n: number): string => {
    let s = "";
    for (let i = 6; i >= 0; i--) {
      s += charset[(n >> (5 * i)) & 31];
    }
    return s;
  };
  const ts = 1_700_000_000;
  assert.equal(bolt11Timestamp("lnbc1" + encode7(ts)), ts);
  assert.equal(bolt11Timestamp("nope"), null);
});

test("handleAddInvoiceResponse accepts expected acks only", () => {
  const mk = (action: string): MessageKind => ({
    version: 2,
    request_id: 7,
    trade_index: null,
    id: UUID,
    action: action as never,
    payload: null,
  });
  assert.equal(handleAddInvoiceResponse(mk("waiting-seller-to-pay"), 7), "accepted");
  assert.equal(handleAddInvoiceResponse(mk("hold-invoice-payment-accepted"), 7), "accepted");
  assert.throws(() => handleAddInvoiceResponse(mk("new-order"), 7), /Unexpected action/);
  assert.throws(() => handleAddInvoiceResponse(mk("waiting-seller-to-pay"), 999), /Mismatched/);
});

test("handleAddBondInvoiceResponse maps follow-up", () => {
  const mk = (action: string): MessageKind => ({
    version: 2,
    request_id: 3,
    trade_index: null,
    id: UUID,
    action: action as never,
    payload: null,
  });
  assert.equal(handleAddBondInvoiceResponse(mk("pay-invoice"), 3), "hold-invoice");
  assert.equal(handleAddBondInvoiceResponse(mk("pay-bond-invoice"), 3), "hold-invoice");
  assert.equal(handleAddBondInvoiceResponse(mk("waiting-buyer-invoice"), 3), "open-invoice");
  assert.equal(handleAddBondInvoiceResponse(mk("add-invoice"), 3), "open-invoice");
  assert.equal(handleAddBondInvoiceResponse(mk("admin-settled"), 3), "ack");
});

test("handleTakeOrderResponse returns add-invoice (buyer invoice popup)", () => {
  const order = {
    id: UUID,
    kind: "sell",
    status: "waiting-buyer-invoice",
    amount: 37876,
    fiat_code: "USD",
    min_amount: null,
    max_amount: null,
    fiat_amount: 30,
    payment_method: "SEPA",
    premium: 0,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: null,
    created_at: 100,
    expires_at: null,
  };
  const kind: MessageKind = {
    version: 2,
    request_id: 9,
    trade_index: 2,
    id: UUID,
    action: "add-invoice",
    payload: { variant: "order", value: order },
  };
  const res = handleTakeOrderResponse(kind, 9);
  assert.equal(res.type, "add-invoice");
  assert.equal(res.order.id, UUID);
});