// Offline unit checks for read getters, stats, trust path, and cache TTL.
//   npx tsx --test extension/tg/read.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { TrustGraph } from "./api.js";
import { MemoryTrustGraphStore } from "./store.js";
import type { Attestation } from "./graph.js";
import { BOOT, HINT, StubEventSource } from "./testkit.js";

const ROOT = "me";
const A = "aaa";
const B = "bbb";

function mk(truster: string, trustee: string, weight: number, createdAt = 1): Attestation {
  return { truster, trustee, weight, d: `tg:v1:market:${trustee}`, createdAt, hint: HINT };
}

async function graphWith(atts: Attestation[], opts: Record<string, unknown> = {}): Promise<TrustGraph> {
  const store = new MemoryTrustGraphStore();
  await store.saveAttestations(atts);
  const tg = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: ROOT, store, ...opts });
  await tg.refresh();
  return tg;
}

test("attestationsTo gives in-edges, attestationsBy gives out-edges", async () => {
  const tg = await graphWith([mk(A, ROOT, 50), mk(ROOT, B, 90)]);
  assert.deepEqual(tg.attestationsTo(ROOT).map((a) => a.truster), [A]);
  assert.deepEqual(tg.attestationsBy(ROOT).map((a) => a.trustee), [B]);
});

test("revokedAttestations lists w=0 revisions", async () => {
  const tg = await graphWith([mk(ROOT, B, 0), mk(ROOT, A, 90)]);
  assert.equal(tg.revokedAttestations().length, 1);
  assert.equal(tg.revokedAttestations()[0]!.trustee, B);
});

test("stats reports received/given/revoked and score", async () => {
  const tg = await graphWith([mk(A, ROOT, 50), mk(ROOT, B, 90), mk(ROOT, A, 0)]);
  const s = tg.stats(ROOT);
  assert.equal(s.received, 1);
  assert.equal(s.given, 1);
  assert.equal(s.revokedGiven, 1);
  assert.ok((s.score ?? 0) > 0);
  assert.ok(s.percentile !== undefined);
});

test("trustPath returns the strongest path root -> identity", async () => {
  const tg = await graphWith([mk(ROOT, A, 90), mk(A, B, 90)]);
  const p = tg.trustPath(B);
  assert.ok(p);
  assert.deepEqual(p.edges.map((e) => [e.from, e.to]), [[ROOT, A], [A, B]]);
  assert.ok(p.score > 0);
  assert.equal(tg.trustPath("unreachable"), null);
});

test("cacheTtlMs ignores a stale persisted snapshot", async () => {
  class StaleStore extends MemoryTrustGraphStore {
    async loadAttestations() {
      return { attestations: [mk(ROOT, B, 90)], savedAt: Date.now() - 10_000 };
    }
  }
  const fresh = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: ROOT, store: new StaleStore(), cacheTtlMs: 60_000 });
  await fresh.refresh();
  assert.ok((fresh.score(B) ?? 0) > 0, "within TTL -> loaded");

  const stale = new TrustGraph({ pool: new StubEventSource(), relays: [BOOT], root: ROOT, store: new StaleStore(), cacheTtlMs: 1_000 });
  await stale.refresh();
  assert.equal(stale.score(B) ?? 0, 0, "past TTL -> ignored");
});
