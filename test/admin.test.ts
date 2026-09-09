import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildTakeDisputeMessage,
  buildAdminSettleMessage,
  buildAdminCancelMessage,
  buildAddSolverMessage,
  handleAdminFinalizeResponse,
  handleTakeDisputeResponse,
  bondSlashToPayload,
  NO_SLASH,
  verifyMessageKind,
} from "../src/protocol/index.js";
import type { MessageKind } from "../src/protocol/index.js";

const UUID = "308e1272-d5f4-47e6-bd97-3504baea9c23";

test("buildTakeDisputeMessage uses dispute channel, no payload", () => {
  const msg = buildTakeDisputeMessage(UUID);
  assert.equal(msg.variant, "dispute");
  assert.equal(msg.value.action, "admin-take-dispute");
  assert.equal(msg.value.id, UUID);
  assert.equal(msg.value.payload, null);
  assert.ok(verifyMessageKind(msg.value));
});

test("buildAdminSettleMessage with bond slash", () => {
  const msg = buildAdminSettleMessage(UUID, 42, { slashSeller: true, slashBuyer: false });
  assert.equal(msg.variant, "dispute");
  assert.equal(msg.value.action, "admin-settle");
  assert.equal(msg.value.request_id, 42);
  assert.deepEqual(msg.value.payload, {
    variant: "bond_resolution",
    value: { slash_seller: true, slash_buyer: false },
  });
  assert.ok(verifyMessageKind(msg.value));
});

test("buildAdminCancelMessage without slash → null payload", () => {
  const msg = buildAdminCancelMessage(UUID, 7, NO_SLASH);
  assert.equal(msg.value.action, "admin-cancel");
  assert.equal(msg.value.payload, null);
  assert.ok(verifyMessageKind(msg.value));
});

test("bondSlashToPayload: no slash → null, any slash → BondResolution", () => {
  assert.equal(bondSlashToPayload(NO_SLASH), null);
  assert.deepEqual(bondSlashToPayload({ slashSeller: true, slashBuyer: false }), {
    variant: "bond_resolution",
    value: { slash_seller: true, slash_buyer: false },
  });
  assert.deepEqual(bondSlashToPayload({ slashSeller: false, slashBuyer: true }), {
    variant: "bond_resolution",
    value: { slash_seller: false, slash_buyer: true },
  });
  assert.deepEqual(bondSlashToPayload({ slashSeller: true, slashBuyer: true }), {
    variant: "bond_resolution",
    value: { slash_seller: true, slash_buyer: true },
  });
});

test("buildAddSolverMessage: read vs read-write payload text", () => {
  const read = buildAddSolverMessage("npub1abc", 1, "read");
  assert.equal(read.value.action, "admin-add-solver");
  assert.deepEqual(read.value.payload, { variant: "text_message", value: "npub1abc:read" });

  const rw = buildAddSolverMessage("npub1abc", 2, "read-write");
  assert.deepEqual(rw.value.payload, { variant: "text_message", value: "npub1abc" });
});

test("handleAdminFinalizeResponse", () => {
  const confirmed: MessageKind = {
    version: 2,
    request_id: 5,
    trade_index: null,
    id: UUID,
    action: "admin-settled",
    payload: null,
  };
  assert.equal(handleAdminFinalizeResponse(confirmed, 5, "admin-settled"), "confirmed");

  const coopCancel: MessageKind = { ...confirmed, action: "cooperative-cancel-accepted" };
  assert.equal(
    handleAdminFinalizeResponse(coopCancel, 5, "admin-settled"),
    "already-cooperatively-canceled",
  );

  assert.throws(
    () => handleAdminFinalizeResponse({ ...confirmed, action: "new-order" }, 5, "admin-settled"),
    /Unexpected action/,
  );
  assert.throws(() => handleAdminFinalizeResponse(confirmed, 999, "admin-settled"), /Mismatched/);
  assert.throws(
    () => handleAdminFinalizeResponse({ ...confirmed, request_id: null }, 5, "admin-settled"),
    /null request_id/,
  );
});

test("handleTakeDisputeResponse", () => {
  handleTakeDisputeResponse({
    version: 2,
    request_id: null,
    trade_index: null,
    id: UUID,
    action: "admin-took-dispute",
    payload: null,
  });
  assert.throws(
    () =>
      handleTakeDisputeResponse({
        version: 2,
        request_id: null,
        trade_index: null,
        id: UUID,
        action: "cant-do",
        payload: { variant: "cant_do", value: null },
      }),
    /Unexpected action/,
  );
});