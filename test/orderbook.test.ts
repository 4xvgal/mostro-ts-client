import { test } from "node:test";
import assert from "node:assert/strict";

import {
  orderFromTags,
  aggregateLatestOrdersById,
  parseOrdersEvents,
  pendingOrdersForBook,
} from "../src/protocol/index.js";

function orderEvent(id: string, created_at: number, extraTags: string[][] = []): {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
} {
  const hasFa = extraTags.some((t) => t[0] === "fa");
  return {
    id: `ev-${id}`,
    pubkey: "6c4b8b42b8bda8e59a155788271ba54febe8bd1dbf1319f3ff0a68d9770ecbbe",
    created_at,
    tags: [
      ["d", id],
      ["k", "sell"],
      ["f", "USD"],
      ["s", "pending"],
      ["amt", "0"],
      ...(hasFa ? [] : [["fa", "100"] as string[]]),
      ["pm", "SEPA"],
      ["premium", "0"],
      ...extraTags,
    ],
  };
}

test("orderFromTags parses a sell order", () => {
  const order = orderFromTags(orderEvent("o1", 100).tags);
  assert.equal(order.id, "o1");
  assert.equal(order.kind, "sell");
  assert.equal(order.fiat_code, "USD");
  assert.equal(order.status, "pending");
  assert.equal(order.fiat_amount, 100);
  assert.equal(order.payment_method, "SEPA");
});

test("orderFromTags handles range fa tag (min:max)", () => {
  const order = orderFromTags(orderEvent("o2", 100, [["fa", "100", "200"]]).tags);
  assert.equal(order.fiat_amount, 0);
  assert.equal(order.min_amount, 100);
  assert.equal(order.max_amount, 200);
});

test("orderFromTags ignores decimal fa values", () => {
  const order = orderFromTags(orderEvent("o3", 100, [["fa", "100.50"]]).tags);
  assert.equal(order.fiat_amount, 0);
});

test("aggregateLatestOrdersById keeps newest per id", () => {
  const events = [
    orderEvent("o1", 100, [["s", "pending"]]),
    orderEvent("o1", 200, [["s", "canceled"]]),
    orderEvent("o2", 150),
  ];
  const latest = aggregateLatestOrdersById(events);
  assert.equal(latest.size, 2);
  assert.equal(latest.get("o1")?.status, "canceled");
  assert.equal(latest.get("o1")?.created_at, 200);
});

test("pendingOrdersForBook filters to pending only + currency", () => {
  const latest = new Map([
    ["o1", orderFromTags(orderEvent("o1", 100).tags)],
    [
      "o2",
      orderFromTags(orderEvent("o2", 100, [["s", "active"], ["f", "EUR"]]).tags),
    ],
  ]);
  const pending = pendingOrdersForBook(latest, null);
  assert.deepEqual(pending.map((o) => o.id), ["o1"]);

  const filtered = pendingOrdersForBook(latest, ["EUR"]);
  assert.deepEqual(filtered.map((o) => o.id), []);
});

test("parseOrdersEvents applies all filters", () => {
  const events = [
    orderEvent("o1", 100),
    orderEvent("o2", 100, [["s", "active"]]),
    orderEvent("o3", 100, [["k", "buy"]]),
  ];
  const pending = parseOrdersEvents(events, { status: "pending" });
  assert.deepEqual(pending.map((o) => o.id).sort(), ["o1", "o3"]);

  const sell = parseOrdersEvents(events, { status: "pending", kind: "sell" });
  assert.deepEqual(sell.map((o) => o.id), ["o1"]);
});

test("orders sorted newest first", () => {
  const events = [orderEvent("old", 100), orderEvent("new", 200)];
  const orders = parseOrdersEvents(events, { status: "pending" });
  assert.deepEqual(orders.map((o) => o.id), ["new", "old"]);
});