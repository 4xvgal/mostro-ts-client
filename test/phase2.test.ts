import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveKeysFromMnemonic,
  deriveIdentityKeys,
  deriveTradeKeys,
  reserveNextTradeIndex,
  generateMnemonic,
  validateMnemonic,
  buildNewOrder,
  handleNewOrderResponse,
  buildTradeMessage,
  identityFromNsec,
  decodeNsec,
  nsecFromSecret,
  identityNsecFromMnemonic,
  keyRequirement,
  TERMINAL_DM_STATUSES,
  TERMINAL_ORDER_HISTORY_STATUSES,
  serializeMessage,
  Status,
  newRequestId,
} from "../src/protocol/index.js";

// Same mnemonic as mostrix/src/models.rs derive_trade_keys_tests.
const SAMPLE_MNEMONIC =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

// Independent cross-client vectors from mostrix (trade key derivation).
// Tuple: (trade_index, expected_pubkey_hex, expected_secret_hex).
const TRADE_KEY_VECTORS: Array<[number, string, string]> = [
  [
    1,
    "1c71f0a29c9d14198781f36897c6d6c08e2c4f905ba69fc5f8e67d375d705a8a",
    "977b9da8056e6a83a991cb31ac507b0a618fbbee355e36e107e0e348686ab833",
  ],
  [
    2,
    "5011d0e7a57ae27627ab76962537072c6809ef3b9e24c2e3db4e672c61624eef",
    "03c78114b80a2db782bb86be47c8062388d78a0585dfa79b8594e105740758c3",
  ],
  [
    5,
    "088bb3266bde36a0d7080b8ae655e86f5c12ac13ec59fa12754f277cdc2c970b",
    "542fe37421c128dd421289d45f498cd99a06701706f33a1a74926e6d2d32182d",
  ],
];

test("trade key derivation matches mostrix/mostro vectors", () => {
  for (const [index, expectedPubkey, expectedSecret] of TRADE_KEY_VECTORS) {
    const keys = deriveTradeKeys(SAMPLE_MNEMONIC, index);
    assert.equal(keys.pubkey, expectedPubkey, `trade index ${index} pubkey`);
    assert.equal(keys.secret, expectedSecret, `trade index ${index} secret`);
    assert.equal(keys.path, `m/44'/1237'/38383'/0/${index}`);
  }
});

test("identity key is index 0 on the same path", () => {
  const identity = deriveIdentityKeys(SAMPLE_MNEMONIC);
  const index0 = deriveTradeKeys(SAMPLE_MNEMONIC, 0);
  assert.equal(identity.secret, index0.secret);
  assert.equal(identity.path, "m/44'/1237'/38383'/0/0");
});

test("reserveNextTradeIndex increments monotonically", () => {
  let state: { lastTradeIndex: number | null } = { lastTradeIndex: null };
  const first = reserveNextTradeIndex(state, SAMPLE_MNEMONIC, 1);
  assert.equal(first.nextIndex, 2);
  assert.deepEqual(first.nextState, { lastTradeIndex: 2 });
  state = first.nextState;
  const second = reserveNextTradeIndex(state, SAMPLE_MNEMONIC, 1);
  assert.equal(second.nextIndex, 3);
  assert.deepEqual(second.keys, deriveTradeKeys(SAMPLE_MNEMONIC, 3));
});

test("derive rejects invalid mnemonic and out-of-range index", () => {
  assert.throws(() => deriveKeysFromMnemonic("not a valid mnemonic phrase at all", 1));
  assert.throws(() => deriveTradeKeys(SAMPLE_MNEMONIC, -1));
  assert.throws(() => deriveTradeKeys(SAMPLE_MNEMONIC, 2 ** 32));
});

test("generateMnemonic produces a valid 12-word mnemonic", () => {
  const mn = generateMnemonic();
  assert.equal(mn.split(" ").length, 12);
  assert.ok(validateMnemonic(mn));
});

test("buildNewOrder assembles a verified NewOrder message", () => {
  const { message, smallOrder, requestId, tradeIndex } = buildNewOrder(
    { lastTradeIndex: null },
    {
      kind: "SELL",
      fiatCode: "eur",
      amount: 100,
      fiatAmount: 100,
      paymentMethod: "SEPA,Bank transfer",
      premium: 1,
      expirationDays: 1,
    },
  );

  assert.equal(message.variant, "order");
  assert.equal(message.value.action, "new-order");
  assert.equal(message.value.trade_index, 2); // noneBase 1 + 1
  assert.equal(message.value.request_id, requestId);
  assert.equal(smallOrder.kind, "sell");
  assert.equal(smallOrder.status, Status.Pending);
  assert.equal(smallOrder.fiat_code, "EUR");
  assert.equal(smallOrder.created_at, 0);
  assert.ok(message.value.version === 2);

  const json = serializeMessage(message);
  assert.ok(json.includes('"action":"new-order"'));
  assert.ok(json.includes('"kind":"sell"'));
  assert.ok(json.includes('"fiat_code":"EUR"'));
});

test("buildNewOrder validates expiration and range orders", () => {
  assert.throws(
    () =>
      buildNewOrder({ lastTradeIndex: 0 }, { amount: 0, fiatAmount: 100, paymentMethod: "x", expirationDays: 0 }),
    /Minimum expiration time/,
  );

  const range = buildNewOrder(
    { lastTradeIndex: 1 },
    {
      amount: 0,
      fiatAmount: 0,
      minAmount: 100,
      maxAmount: 200,
      paymentMethod: "SEPA",
      expirationDays: 2,
    },
  );
  assert.equal(range.smallOrder.fiat_amount, 0);
  assert.equal(range.smallOrder.min_amount, 100);
  assert.equal(range.smallOrder.max_amount, 200);
});

test("handleNewOrderResponse dispatches success and bond paths", () => {
  const uuid = "308e1272-d5f4-47e6-bd97-3504baea9c23";
  const okOrder = {
    variant: "order",
    value: {
      id: uuid,
      kind: "sell" as const,
      status: "pending" as const,
      amount: 100,
      fiat_code: "eur",
      min_amount: null,
      max_amount: null,
      fiat_amount: 100,
      payment_method: "SEPA",
      premium: 1,
      buyer_trade_pubkey: null,
      seller_trade_pubkey: null,
      buyer_invoice: null,
      created_at: 1627371434,
      expires_at: null,
    },
  };

  const created = handleNewOrderResponse(
    { version: 2, request_id: 42, trade_index: 2, id: uuid, action: "new-order", payload: okOrder },
    42,
  );
  assert.equal(created.type, "order-created");
  assert.equal(created.order.id, uuid);

  const bond = handleNewOrderResponse(
    {
      version: 2,
      request_id: 43,
      trade_index: 3,
      id: uuid,
      action: "pay-bond-invoice",
      payload: { variant: "payment_request", value: [null, "lnbcrt1", 50000] },
    },
    43,
  );
  assert.equal(bond.type, "bond-invoice");
  assert.equal(bond.invoice, "lnbcrt1");
  assert.equal(bond.amount, 50000);

  assert.throws(
    () => handleNewOrderResponse({ version: 2, request_id: 999, trade_index: 2, id: uuid, action: "new-order", payload: okOrder }, 42),
    /Mismatched request_id/,
  );
  assert.throws(
    () => handleNewOrderResponse({ version: 2, request_id: null, trade_index: 1, id: null, action: "new-order", payload: null }, 1),
    /null request_id/,
  );
});

test("buildTradeMessage produces verified messages for rate-user etc", () => {
  const msg = buildTradeMessage({
    orderId: "308e1272-d5f4-47e6-bd97-3504baea9c23",
    requestId: 7,
    action: "rate-user",
    payload: { variant: "rating_user", value: 5 },
  });
  assert.equal(msg.value.action, "rate-user");
  assert.equal(msg.value.request_id, 7);
});

test("request_id is a positive integer from uuid top bits", () => {
  const id = newRequestId();
  assert.ok(Number.isInteger(id));
  assert.ok(id > 0);
});

test("terminal status sets match mostrix", () => {
  assert.ok(TERMINAL_DM_STATUSES.includes("canceled"));
  assert.ok(!TERMINAL_DM_STATUSES.includes("success"));
  assert.ok(TERMINAL_ORDER_HISTORY_STATUSES.includes("success"));
  assert.deepEqual([...TERMINAL_ORDER_HISTORY_STATUSES].sort(), [
    "canceled",
    "canceled-by-admin",
    "completed-by-admin",
    "cooperatively-canceled",
    "expired",
    "settled-by-admin",
    "success",
  ]);
});

test("key injection: mnemonic → identity nsec roundtrip", () => {
  const nsec = identityNsecFromMnemonic(SAMPLE_MNEMONIC);
  assert.ok(nsec.startsWith("nsec1"));
  const identity = deriveIdentityKeys(SAMPLE_MNEMONIC);
  assert.equal(nsecFromSecret(identity.secret), nsec);
});