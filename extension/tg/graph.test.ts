// Offline unit checks for hint-routed, bounded graph expansion.
//   npx tsx --test extension/tg/graph.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import type { NostrEvent } from "nostr-tools/core";
import {
  parseAttestation,
  adjacencyFromAttestations,
  fetchGraph,
  ATTESTATION_KIND,
  type Attestation,
} from "./graph.js";
import { BOOT, HINT, att, StubEventSource } from "./testkit.js";

test("parseAttestation reads the p-tag hint, clamps weight, rejects junk", () => {
  assert.deepEqual(parseAttestation(att("aa", "bb", HINT, 150)), {
    truster: "aa",
    trustee: "bb",
    weight: 100,
    d: "tg:v1:market:bb",
    createdAt: 100,
    hint: HINT,
    expiresAt: undefined,
  });
  assert.equal(parseAttestation(att("R", "B"))?.hint, null);
  assert.equal(parseAttestation(att("R", "B", "http://not-a-relay"))?.hint, null);
  assert.equal(parseAttestation({ ...att("R", "B"), kind: 1 } as NostrEvent), null);
});

// Table-driven routing: store, root, options, expected adjacency, expected flags.
interface Case {
  name: string;
  store: Array<[string, NostrEvent[]]>;
  root?: string;
  opts?: Record<string, unknown>;
  edges: Array<[string, string[]]>;
  requireHintDefault?: boolean;
}
const routingCases: Case[] = [
  {
    name: "hint routes the next hop when bootstrap lacks it",
    store: [
      [BOOT, [att("R", "B", HINT)]],
      [HINT, [att("B", "D", HINT)]],
    ],
    edges: [["R", ["B"]], ["B", ["D"]]],
  },
  {
    name: "hint-less attestation is rejected (no hidden leaf)",
    store: [[BOOT, [att("R", "B"), att("B", "D", HINT)]]],
    edges: [],
  },
  {
    name: "invalid hint url is treated as no hint -> rejected",
    store: [[BOOT, [att("R", "B", "not a url")]]],
    edges: [],
  },
  {
    name: "hint relay that yields nothing leaves an accepted leaf",
    store: [[BOOT, [att("R", "B", HINT)]]],
    edges: [["R", ["B"]]],
  },
  {
    name: "requireHint:false keeps legacy hint-less edges",
    store: [[BOOT, [att("R", "B")]]],
    opts: { requireHint: false },
    edges: [["R", ["B"]]],
  },
];

for (const c of routingCases) {
  test(c.name, async () => {
    const res = await fetchGraph({ pool: new StubEventSource(new Map(c.store)), relays: [BOOT], root: c.root ?? "R", maxHop: 3, ...c.opts });
    const edges = [...res.adjacency].map(([u, es]) => [u, es.map((e) => e.to)] as [string, string[]]);
    assert.deepEqual(edges, c.edges);
  });
}

test("events from non-requested authors are dropped (untrusted relay)", async () => {
  const store = new Map([[BOOT, [att("R", "B", HINT), att("EVIL", "R", HINT)]]]);
  const res = await fetchGraph({ pool: new StubEventSource(store), relays: [BOOT], root: "R", maxHop: 2 });
  assert.ok(res.attestations.every((a) => a.truster !== "EVIL"));
});

test("maxNodes caps the total budget", async () => {
  const store = new Map([[BOOT, Array.from({ length: 10 }, (_, i) => att("R", `N${i}`, HINT))]]);
  const pool = new StubEventSource(store);
  const res = await fetchGraph({ pool, relays: [BOOT], root: "R", maxHop: 3, maxNodes: 4 });
  assert.equal(pool.calls[0]!.authors.length, 1); // hop 0: only root
  assert.equal(pool.calls[1]!.authors.length, 3); // hop 1: 4 - root = 3
  assert.equal(res.truncated, true);
});

test("maxOutDegreePerNode keeps only the strongest edges", async () => {
  const store = new Map([[BOOT, Array.from({ length: 10 }, (_, i) => att("R", `N${i}`, HINT, 10 + i))]]);
  const res = await fetchGraph({ pool: new StubEventSource(store), relays: [BOOT], root: "R", maxHop: 1, maxOutDegreePerNode: 3 });
  assert.equal(res.adjacency.get("R")?.length, 3);
});

test("deadline stops expansion and marks truncated", async () => {
  class SlowPool extends StubEventSource {
    async querySync(relays: string[], filter: Parameters<StubEventSource["querySync"]>[1]): Promise<NostrEvent[]> {
      await new Promise((r) => setTimeout(r, 25));
      return super.querySync(relays, filter);
    }
  }
  const pool = new SlowPool(new Map([[BOOT, [att("R", "B", HINT)]]]));
  const res = await fetchGraph({ pool, relays: [BOOT], root: "R", maxHop: 3, deadlineMs: 1 });
  assert.equal(res.truncated, true);
});

test("adjacency keeps newest replaceable revision and drops zero weights", () => {
  const mk = (weight: number, createdAt: number, trustee = "bb"): Attestation => ({
    truster: "aa",
    trustee,
    weight,
    d: `tg:v1:market:${trustee}`,
    createdAt,
    hint: HINT,
  });
  const g = adjacencyFromAttestations([mk(30, 5), mk(70, 9), mk(0, 9, "cc")]);
  assert.deepEqual(g.get("aa"), [{ to: "bb", weight: 70 }]);
});
