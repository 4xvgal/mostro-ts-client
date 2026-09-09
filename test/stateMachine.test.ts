import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldApplyStatusTransition,
  shouldStrictlyAdvanceStatus,
  inferredStatusFromTradeAction,
  isTerminalTradeStatus,
  statusPhaseRankForActor,
  mapActionToStatus,
} from "../src/protocol/index.js";

test("terminal statuses are sticky", () => {
  assert.ok(isTerminalTradeStatus("success"));
  assert.ok(isTerminalTradeStatus("canceled"));
  assert.ok(isTerminalTradeStatus("expired"));
  assert.ok(!isTerminalTradeStatus("pending"));
  assert.ok(!isTerminalTradeStatus("fiat-sent"));
});

test("null current always accepts", () => {
  assert.ok(shouldApplyStatusTransition(null, "pending", "sell", null));
  assert.ok(shouldApplyStatusTransition(null, "success", "buy", null));
});

test("equal status is accepted", () => {
  assert.ok(shouldApplyStatusTransition("pending", "pending", "sell", null));
});

test("monotonic progression on sell listing", () => {
  // sell: waiting-buyer-invoice(1) -> waiting-payment(2) -> active(3) -> fiat-sent(4)
  assert.ok(shouldApplyStatusTransition("waiting-buyer-invoice", "waiting-payment", "sell", null));
  assert.ok(shouldApplyStatusTransition("waiting-payment", "active", "sell", null));
  assert.ok(shouldApplyStatusTransition("active", "fiat-sent", "sell", null));
  assert.ok(shouldApplyStatusTransition("fiat-sent", "settled-hold-invoice", "sell", null));
  assert.ok(shouldApplyStatusTransition("settled-hold-invoice", "success", "sell", null));
});

test("monotonic progression on buy listing", () => {
  // buy: waiting-payment(1) -> waiting-buyer-invoice(2) -> active(3)
  assert.ok(shouldApplyStatusTransition("waiting-payment", "waiting-buyer-invoice", "buy", null));
  assert.ok(shouldApplyStatusTransition("waiting-buyer-invoice", "active", "buy", null));
});

test("backward transitions rejected", () => {
  assert.ok(!shouldApplyStatusTransition("success", "fiat-sent", "sell", null));
  assert.ok(!shouldApplyStatusTransition("active", "pending", "sell", null));
  assert.ok(!shouldApplyStatusTransition("fiat-sent", "waiting-payment", "sell", null));
});

test("unknown edge keeps existing status", () => {
  // InProgress has no rank; candidate with no rank → false (safer).
  assert.ok(!shouldApplyStatusTransition("in-progress", "pending", null, null));
});

test("post-retry AddInvoice reopens Success → SettledHoldInvoice only", () => {
  assert.ok(
    shouldApplyStatusTransition("success", "settled-hold-invoice", "sell", "add-invoice"),
  );
  assert.ok(
    !shouldApplyStatusTransition("success", "settled-hold-invoice", "sell", "release"),
  );
  assert.ok(
    !shouldApplyStatusTransition("success", "settled-hold-invoice", "sell", null),
  );
  assert.ok(
    !shouldApplyStatusTransition("canceled", "settled-hold-invoice", "sell", "add-invoice"),
  );
});

test("relay reconcile (action null) cannot reopen terminal", () => {
  assert.ok(!shouldApplyStatusTransition("success", "active", "sell", null));
  assert.ok(!shouldStrictlyAdvanceStatus("success", "success", "sell", null));
});

test("inferredStatusFromTradeAction", () => {
  assert.equal(inferredStatusFromTradeAction("canceled"), "canceled");
  assert.equal(inferredStatusFromTradeAction("fiat-sent-ok"), "fiat-sent");
  assert.equal(inferredStatusFromTradeAction("purchase-completed"), "success");
  assert.equal(inferredStatusFromTradeAction("release"), "settled-hold-invoice");
  assert.equal(inferredStatusFromTradeAction("pay-bond-invoice"), "waiting-taker-bond");
  assert.equal(inferredStatusFromTradeAction("new-order"), null);
});

test("rank ordering by kind", () => {
  assert.equal(statusPhaseRankForActor("waiting-payment", "buy"), 1);
  assert.equal(statusPhaseRankForActor("waiting-payment", "sell"), 2);
  assert.equal(statusPhaseRankForActor("waiting-buyer-invoice", "buy"), 2);
  assert.equal(statusPhaseRankForActor("waiting-buyer-invoice", "sell"), 1);
  assert.equal(statusPhaseRankForActor("pending", "sell"), 0);
  assert.equal(statusPhaseRankForActor("success", "sell"), 6);
  assert.equal(statusPhaseRankForActor("canceled", "sell"), null);
});

test("mapActionToStatus prefers explicit order status", () => {
  const order = {
    id: null,
    kind: "sell" as const,
    status: "waiting-payment" as const,
    amount: 100,
    fiat_code: "EUR",
    min_amount: null,
    max_amount: null,
    fiat_amount: 100,
    payment_method: "SEPA",
    premium: 0,
    buyer_trade_pubkey: null,
    seller_trade_pubkey: null,
    buyer_invoice: null,
    created_at: 0,
    expires_at: null,
  };
  assert.equal(mapActionToStatus("canceled", order), "waiting-payment");

  const noStatus = { ...order, status: null as const };
  assert.equal(mapActionToStatus("purchase-completed", noStatus), "success");
});