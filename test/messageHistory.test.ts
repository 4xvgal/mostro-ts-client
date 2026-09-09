import { test } from "node:test";
import assert from "node:assert/strict";

import { SimplePool } from "nostr-tools/pool";
import { MostroClient, generateMnemonic, openSqliteStore } from "../src/protocol/index.js";
import type { Message } from "../src/protocol/index.js";

const RELAY = "ws://localhost:7080";

function makeDm(action: string, orderId: string): Message {
  return {
    variant: "order",
    value: {
      version: 2,
      request_id: 1,
      trade_index: 2,
      id: orderId,
      action: action as never,
      payload: null,
    },
  };
}

test("onMessage records history per order", async () => {
  const pool = new SimplePool();
  const client = new MostroClient({
    mnemonic: generateMnemonic(),
    mostroPubkey: "6c4b8b42b8bda8e59a155788271ba54febe8bd1dbf1319f3ff0a68d9770ecbbe",
    relays: [RELAY],
    store: openSqliteStore(),
  });

  await client.start();

  const recorder = client as unknown as {
    recordMessage(o: string | null, m: Message, t: number): void;
  };

  recorder.recordMessage("order-1", makeDm("fiat-sent-ok", "order-1"), 1000);
  recorder.recordMessage("order-1", makeDm("hold-invoice-payment-settled", "order-1"), 2000);

  const history = client.getMessages("order-1");
  assert.equal(history.length, 2);
  assert.equal(history[0]!.message.value.action, "fiat-sent-ok");
  assert.equal(history[1]!.message.value.action, "hold-invoice-payment-settled");
  assert.equal(history[0]!.timestamp, 1000);

  let fired: string | null = null;
  client.onMessage("order-1", (dm) => {
    fired = dm.message.value.action;
  });
  recorder.recordMessage("order-1", makeDm("released", "order-1"), 3000);
  assert.equal(fired, "released");

  recorder.recordMessage(null, makeDm("new-order", "x"), 4000);
  assert.equal(client.getMessages("x").length, 0);

  await client.stop();
  pool.close([RELAY]);
});