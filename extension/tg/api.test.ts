// Offline unit checks for the TrustGraph facade: seed edges, cache, start/stop.
//   npx tsx --test extension/tg/api.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustGraph } from "./api.js";
import { MemoryTrustGraphStore } from "./store.js";
import { BOOT, HINT, att, orderEvent, StubEventSource, sleep } from "./testkit.js";

test("seed() injects private edges into the graph", async () => {
  const tg = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: "R" });
  tg.seed([{ to: "B", weight: 90 }, { to: "C", weight: 20 }]);
  await tg.refresh();
  assert.ok((tg.score("B") ?? 0) > 0, "seeded B should score");
  assert.ok((tg.score("C") ?? 0) > 0, "seeded C should score");
  assert.ok((tg.score("B") ?? 0) > (tg.score("C") ?? 0), "stronger seed scores higher");
});

test("cache accumulates attestations across refreshes", async () => {
  const src = new StubEventSource(new Map(), true);
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: "R" });
  src.store = new Map([[BOOT, [att("R", "B", HINT)]]]);
  await tg.refresh();
  assert.ok((tg.score("B") ?? 0) > 0);
  src.store = new Map([[BOOT, [att("R", "B", HINT), att("R", "C", HINT)]]]);
  await tg.refresh();
  assert.ok((tg.score("C") ?? 0) > 0, "new attestation picked up");
  assert.ok((tg.score("B") ?? 0) > 0, "previous attestation retained via cache");
});

test("start() refreshes periodically; stop() halts it", async () => {
  const src = new StubEventSource(new Map(), true);
  let updates = 0;
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: "R", onUpdate: () => updates++ });
  tg.start({ intervalMs: 10 });
  await sleep(40);
  tg.stop();
  assert.ok(updates >= 2, `expected multiple refreshes, got ${updates}`);
  const afterStop = updates;
  await sleep(30);
  assert.equal(updates, afterStop, "no refreshes after stop()");
});

test("scorer strategy overrides the default PPR", async () => {
  const tg = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: "R", scorer: () => new Map([["X", 1]]) });
  await tg.refresh();
  assert.equal(tg.score("X"), 1);
});

test("store hydrates the attestation cache across instances", async () => {
  const store = new MemoryTrustGraphStore();
  await store.saveAttestations([{ truster: "R", trustee: "B", weight: 90, d: "seed:B", createdAt: 1, hint: null }]);
  const tg = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: "R", store });
  await tg.refresh();
  assert.ok((tg.score("B") ?? 0) > 0, "persisted edge loaded into the graph");
});

test("live subscription ingests attestations and updates scores", async () => {
  const src = new StubEventSource(new Map(), true);
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: "R", liveDebounceMs: 0 });
  await tg.refresh();
  tg.start({ live: true, intervalMs: 1_000_000 });
  assert.equal(src.subCount, 2, "orders + attestations subscriptions");
  src.emit(att("R", "B", HINT, 90));
  await sleep(20);
  assert.ok((tg.score("B") ?? 0) > 0, "live attestation reflected");
  tg.stop();
  assert.equal(src.subCount, 0, "subscriptions closed on stop");
});

test("live observation order drives first-seen, not event timestamps", async () => {
  const src = new StubEventSource(new Map(), true);
  const tg = new TrustGraph({ pool: src, relays: [BOOT], root: "R", liveDebounceMs: 0 });
  await tg.refresh();
  tg.start({ live: true, intervalMs: 1_000_000 });
  // Genuine A observed first; spoof B observed second but with an EARLIER created_at.
  src.emit(orderEvent("A", 5000));
  await sleep(5);
  src.emit(orderEvent("B", 1000));
  await sleep(5);
  const nonce = new Uint8Array([9, 9, 9]);
  assert.equal(tg.observeOrder({ identity: "I", nonce, orderId: "A" }), "valid");
  assert.equal(tg.observeOrder({ identity: "I", nonce, orderId: "B" }), "invalid");
  tg.stop();
});

test("first-seen ledger persists across instances", async () => {
  const store = new MemoryTrustGraphStore();
  const nonce = new Uint8Array([1, 2, 3]);
  const tg1 = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: "R", store });
  await tg1.refresh();
  assert.equal(tg1.observeOrder({ identity: "I", nonce, orderId: "o1", observedAt: 100 }), "valid");
  await sleep(10);
  const tg2 = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: "R", store });
  await tg2.refresh(); // hydrate
  assert.equal(tg2.observeOrder({ identity: "I", nonce, orderId: "o2", observedAt: 200 }), "invalid");
});
