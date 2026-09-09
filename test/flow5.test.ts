import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRateUserMessage,
  handleRateUserResponse,
  buildTradeMessage,
  handleNewOrderResponse,
  handleTakeOrderResponse,
  buildTakeOrderPayload,
  buildDisputeMessage,
  handleDisputeNotification,
  CantDoError,
  verifyMessageKind,
} from "../src/protocol/index.js";
import type { MessageKind } from "../src/protocol/index.js";

const UUID = "308e1272-d5f4-47e6-bd97-3504baea9c23";

test("buildRateUserMessage builds verified message", () => {
  const msg = buildRateUserMessage({ orderId: UUID, requestId: 42, rating: 4 });
  assert.equal(msg.variant, "order");
  assert.equal(msg.value.action, "rate-user");
  assert.equal(msg.value.id, UUID);
  assert.equal(msg.value.payload?.variant, "rating_user");
  assert.equal(msg.value.payload?.value, 4);
  assert.ok(verifyMessageKind(msg.value));
});

test("buildRateUserMessage rejects out-of-range rating", () => {
  assert.throws(() => buildRateUserMessage({ orderId: UUID, requestId: 1, rating: 0 }), /between 1 and 5/);
  assert.throws(() => buildRateUserMessage({ orderId: UUID, requestId: 1, rating: 6 }), /between 1 and 5/);
});

test("handleRateUserResponse accepts RateReceived, rejects others", () => {
  const ok: MessageKind = {
    version: 2,
    request_id: 7,
    trade_index: null,
    id: UUID,
    action: "rate-received",
    payload: null,
  };
  handleRateUserResponse(ok, 7);

  assert.throws(
    () => handleRateUserResponse({ ...ok, action: "new-order" }, 7),
    /Unexpected action/,
  );
  assert.throws(() => handleRateUserResponse(ok, 999), /Mismatched request_id/);
  assert.throws(() => handleRateUserResponse({ ...ok, request_id: null }, 7), /null request_id/);
});

test("take-order helpers still work together", () => {
  // Rate flows reuse buildTradeMessage for other trade actions.
  const rate = buildTradeMessage({
    orderId: UUID,
    requestId: 1,
    action: "rate-user",
    payload: { variant: "rating_user", value: 5 },
  });
  assert.equal(rate.value.action, "rate-user");

  const order = buildTakeOrderPayload({ action: "take-sell" });
  assert.deepEqual(order, { variant: "amount", value: 0 });
});

test("CantDoError surfaces structured refusal", () => {
  const err = new CantDoError("not_allowed_by_status", 5);
  assert.equal(err.reason, "not_allowed_by_status");
  assert.equal(err.requestId, 5);
  assert.match(err.message, /not_allowed_by_status/);
});

test("handleTakeOrderResponse throws CantDoError on refusal", () => {
  const kind: MessageKind = {
    version: 2,
    request_id: 9,
    trade_index: null,
    id: UUID,
    action: "cant-do",
    payload: { variant: "cant_do", value: "not_allowed_by_status" },
  };
  assert.throws(() => handleTakeOrderResponse(kind, 9), CantDoError);
});

test("handleNewOrderResponse handles bond path", () => {
  const kind: MessageKind = {
    version: 2,
    request_id: 3,
    trade_index: 2,
    id: UUID,
    action: "pay-bond-invoice",
    payload: { variant: "payment_request", value: [null, "lnbcrt1", 50000] },
  };
  const res = handleNewOrderResponse(kind, 3);
  assert.equal(res.type, "bond-invoice");
  assert.equal(res.invoice, "lnbcrt1");
  assert.equal(res.amount, 50000);
});

test("buildDisputeMessage opens a verified dispute", () => {
  const msg = buildDisputeMessage({ orderId: UUID, requestId: 11 });
  assert.equal(msg.variant, "order");
  assert.equal(msg.value.action, "dispute");
  assert.equal(msg.value.id, UUID);
  assert.equal(msg.value.payload, null);
  assert.ok(verifyMessageKind(msg.value));
});

test("handleDisputeNotification parses initiator + dispute id", () => {
  const you: MessageKind = {
    version: 2,
    request_id: 12,
    trade_index: null,
    id: UUID,
    action: "dispute-initiated-by-you",
    payload: { variant: "dispute", value: ["dispute-uuid-1", null] },
  };
  const notif = handleDisputeNotification(you);
  assert.equal(notif.orderId, UUID);
  assert.equal(notif.disputeId, "dispute-uuid-1");
  assert.equal(notif.initiatedByYou, true);

  const peer: MessageKind = {
    ...you,
    action: "dispute-initiated-by-peer",
    payload: { variant: "dispute", value: ["dispute-uuid-2", null] },
  };
  const peerNotif = handleDisputeNotification(peer);
  assert.equal(peerNotif.disputeId, "dispute-uuid-2");
  assert.equal(peerNotif.initiatedByYou, false);
});

test("handleDisputeNotification rejects malformed", () => {
  const noDisputeId: MessageKind = {
    version: 2,
    request_id: 1,
    trade_index: null,
    id: UUID,
    action: "dispute-initiated-by-you",
    payload: null,
  };
  assert.throws(() => handleDisputeNotification(noDisputeId), /missing dispute payload/);

  const wrongAction: MessageKind = { ...noDisputeId, action: "new-order" };
  assert.throws(() => handleDisputeNotification(wrongAction), /Unexpected action/);
});