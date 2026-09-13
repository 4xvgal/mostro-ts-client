// Offline checks for persistence adapters (file + localStorage).
//   npx tsx --test extension/tg/store-adapters.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTrustGraphStore, openFileTrustGraphStore } from "./store-node.js";
import type { Attestation } from "./graph.js";

const att: Attestation = { truster: "a", trustee: "b", weight: 50, d: "tg:v1:market:b", createdAt: 1, hint: "wss://h" };

test("FileTrustGraphStore round-trips attestations + first-seen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-store-"));
  const path = join(dir, "tg.json");
  try {
    const s = openFileTrustGraphStore(path);
    await s.saveAttestations([att]);
    await s.saveFirstSeen({ k: { orderId: "o", ts: 1 } });

    const s2 = new FileTrustGraphStore(path);
    assert.deepEqual((await s2.loadAttestations())?.attestations, [att]);
    assert.deepEqual(await s2.loadFirstSeen(), { k: { orderId: "o", ts: 1 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalStorageTrustGraphStore round-trips attestations + first-seen", async () => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  const { LocalStorageTrustGraphStore } = await import("./store-browser.js");
  const s = new LocalStorageTrustGraphStore("tg-test");
  await s.saveAttestations([att]);
  await s.saveFirstSeen({ k: { orderId: "o", ts: 1 } });

  const s2 = new LocalStorageTrustGraphStore("tg-test");
  assert.deepEqual((await s2.loadAttestations())?.attestations, [att]);
  assert.deepEqual(await s2.loadFirstSeen(), { k: { orderId: "o", ts: 1 } });
});
