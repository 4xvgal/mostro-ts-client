// Relay-only E2E: publish the 5-node trust graph as kind 30500 to the local
// regtest relay, collect it back via fetchGraph, and assert the frozen PPR
// vector. No mostrod involved (off-Mostro social layer).
//
//   MOSTRO_RELAY=ws://localhost:7080 npx tsx extension/tg/e2e-regtest.ts

import assert from "node:assert/strict";
import { SimplePool } from "nostr-tools/pool";
import { generateMnemonic, deriveIdentityKeys, type DerivedKeys } from "../../src/protocol/index.js";
import { fetchGraph } from "./graph.js";
import { computePpr } from "./ppr.js";
import { RELAY, attestationEvent } from "./e2e-kit.js";

const EDGES: Array<[string, string, number]> = [
  ["R", "B", 50],
  ["R", "C", 50],
  ["B", "D", 100],
  ["C", "D", 50],
  ["C", "E", 50],
];
const EXPECTED: Record<string, number> = {
  R: 0.409836065574,
  D: 0.196721311475,
  B: 0.163934426230,
  C: 0.163934426230,
  E: 0.065573770492,
};
const REL = 1e-5;

async function main() {
  const pool = new SimplePool();
  const labels = ["R", "B", "C", "D", "E"];
  const keys = new Map<string, DerivedKeys>();
  for (const label of labels) {
    keys.set(label, deriveIdentityKeys(generateMnemonic()));
  }
  const pubToLabel = new Map([...keys].map(([l, k]) => [k.pubkey, l]));

  // Publish all attestations.
  for (const [from, to, w] of EDGES) {
    const ev = attestationEvent(keys.get(from)!, keys.get(to)!, { weight: w, hint: RELAY });
    await Promise.all(pool.publish([RELAY], ev));
    console.log(`published 30500 ${from}->${to} w=${w}`);
  }

  // Collect back — retry briefly, relays are async.
  const root = keys.get("R")!.pubkey;
  let result = await fetchGraph({ pool, relays: [RELAY], root, maxHop: 3 });
  for (let i = 0; i < 10 && result.adjacency.size < 3; i++) {
    await new Promise((r) => setTimeout(r, 500));
    result = await fetchGraph({ pool, relays: [RELAY], root, maxHop: 3 });
  }
  console.log(`fetchGraph: ${result.attestations.length} attestations, ${result.adjacency.size} sources`);
  assert.equal(result.adjacency.size, 3, "expected R, B, C to have outgoing edges");

  const scores = computePpr(result.adjacency, root, { alpha: 0.8 });
  let sum = 0;
  for (const [label, want] of Object.entries(EXPECTED)) {
    const got = scores.get(keys.get(label)!.pubkey);
    assert.ok(got !== undefined, `node ${label} unreachable`);
    assert.ok(Math.abs(got - want) < REL, `${label}: ${got} != ${want}`);
    sum += got;
    console.log(`  ${label} ${got.toFixed(9)}  (want ${want.toFixed(9)})`);
  }
  assert.ok(Math.abs(sum - 1) < REL, `sum=${sum}`);

  pool.close([RELAY]);
  console.log("RELAY-ONLY E2E PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
