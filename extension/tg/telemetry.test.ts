// Offline checks for telemetry collection + summary + JSONL reader.
//   npx tsx --test extension/tg/telemetry.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateMnemonic,
  deriveIdentityKeys,
  newSmallOrder,
  Kind,
  Status,
} from "../../src/protocol/index.js";
import { MemoryTelemetrySink, summarizeTelemetry, formatSummary } from "./telemetry.js";
import { readTelemetryJsonl } from "./telemetry-node.js";
import { TrustGraph, buildOrderBinding } from "./api.js";
import { IdentityIndex, annotateOrders, type TrustScorer } from "./join.js";
import { BOOT, HINT, StubEventSource } from "./testkit.js";

const id1 = deriveIdentityKeys(generateMnemonic());
const id2 = deriveIdentityKeys(generateMnemonic());

test("summarizeTelemetry aggregates badges, rates, latency and relays", () => {
  const sink = new MemoryTelemetrySink();
  sink.emit({ ev: "refresh", ts: 1, nodes: 10, edges: 20, truncated: false, ms: 100, relaysQueried: 3, hintedNodes: 2 });
  sink.emit({ ev: "refresh", ts: 2, nodes: 10, edges: 20, truncated: true, ms: 300, relaysQueried: 3, hintedNodes: 2 });
  sink.emit({ ev: "annotate", ts: 3, state: "도달", resolved: true, ratingCount: 5, score: 0.2, percentile: 0.8, flags: [] });
  sink.emit({ ev: "annotate", ts: 4, state: "farm-suspect", resolved: true, ratingCount: 0, score: 0.1, percentile: 0.95, flags: ["rating-0", "ppr-high"] });
  sink.emit({ ev: "firstSeen", ts: 5, verdict: "valid" });
  sink.emit({ ev: "firstSeen", ts: 6, verdict: "invalid" });
  sink.emit({ ev: "publish", ts: 7, op: "attest", relayOk: 2, relayFail: 1 });

  const s = summarizeTelemetry(sink.events);
  assert.equal(s.refreshCount, 2);
  assert.equal(s.annotateCount, 2);
  assert.equal(s.resolveRate, 1);
  assert.equal(s.flagRate, 0.5);
  assert.equal(s.badgeDistribution["farm-suspect"], 1);
  assert.equal(s.firstSeen.valid, 1);
  assert.equal(s.firstSeen.invalid, 1);
  assert.equal(s.publish.relayOk, 2);
  assert.equal(s.publish.relayFail, 1);
  assert.equal(s.graph.truncatedRate, 0.5);
  assert.equal(s.latencyMs.max, 300);
  assert.ok(formatSummary(s).includes("resolve=100.0%"));
});

test("TrustGraph emits refresh / firstSeen / publish telemetry", async () => {
  const sink = new MemoryTelemetrySink();
  const tg = new TrustGraph({ pool: new StubEventSource(new Map(), true), relays: [BOOT], root: "R", telemetry: sink });
  await tg.refresh();
  tg.observeOrder({ identity: "I", nonce: new Uint8Array([1]), orderId: "o1" });
  await tg.publishAttestation({ trusterSecretHex: id1.secret, trustee: id2.pubkey, weight: 50, hint: HINT });
  const kinds = sink.events.map((e) => e.ev);
  assert.ok(kinds.includes("refresh"));
  assert.ok(kinds.includes("firstSeen"));
  assert.ok(kinds.includes("publish"));
});

test("annotateOrders emits one annotate event per order", () => {
  const sink = new MemoryTelemetrySink();
  const idx = new IdentityIndex();
  idx.addClaim("o1", { identity: id1.pubkey, source: "social-index" });
  const scorer: TrustScorer = { score: (id) => (id === id1.pubkey ? 0.2 : undefined), percentile: () => 0.95 };
  const { pm } = buildOrderBinding({ identitySecretHex: id1.secret, mostroPubkey: id2.pubkey, kind: "sell", fiatCode: "USD", premium: 0, basePaymentMethod: "SEPA", fiatAmount: 25 });
  const order = newSmallOrder({ id: "o1", kind: Kind.Sell, status: Status.Pending, amount: 0, fiat_code: "USD", fiat_amount: 25, payment_method: pm, premium: 0 });
  annotateOrders([order], { graph: scorer, mostroPubkey: id2.pubkey, identityIndex: idx, telemetry: sink });
  assert.equal(sink.events.filter((e) => e.ev === "annotate").length, 1);
});

test("readTelemetryJsonl parses a JSONL file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-tel-"));
  const path = join(dir, "t.jsonl");
  try {
    writeFileSync(path, JSON.stringify({ ev: "refresh", ts: 1, nodes: 1, edges: 0, truncated: false, ms: 5, relaysQueried: 1, hintedNodes: 0 }) + "\n");
    const events = await readTelemetryJsonl(path);
    assert.equal(events.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
