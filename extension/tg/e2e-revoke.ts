// E2E: revoke propagation. Republish the same 30500 `d` tag with w=0 (못믿음 =
// removal) and confirm the relay replaces the old revision and the PPR graph
// drops the edge.
//
//   MOSTRO_RELAY=ws://localhost:7080 npx tsx extension/tg/e2e-revoke.ts

import assert from "node:assert/strict";
import { SimplePool } from "nostr-tools/pool";
import { generateMnemonic, deriveIdentityKeys, type DerivedKeys } from "../../src/protocol/index.js";
import { ATTESTATION_KIND, fetchGraph } from "./graph.js";
import { computePpr } from "./ppr.js";
import { RELAY, attestationEvent } from "./e2e-kit.js";

const CONTEXT = "market";

async function fetchAndScore(pool: SimplePool, root: string, seed: string) {
  const res = await fetchGraph({ pool, relays: [RELAY], root, maxHop: 3 });
  const scores = computePpr(res.adjacency, root, { alpha: 0.8 });
  const edges = [...res.adjacency].flatMap(([u, es]) => es.map((e) => `${seed}+${u.slice(0, 4)}->${e.to.slice(0, 4)}`));
  return { res, scores, edges };
}

async function main() {
  const pool = new SimplePool();
  const R = deriveIdentityKeys(generateMnemonic());
  const B = deriveIdentityKeys(generateMnemonic());
  const C = deriveIdentityKeys(generateMnemonic());

  const t0 = Math.floor(Date.now() / 1000);
  // R->B (high), R->C (mid), B->C (high)
  for (const [from, to, w] of [
    [R, B, 90],
    [R, C, 50],
    [B, C, 90],
  ] as Array<[DerivedKeys, DerivedKeys, number]>) {
    await Promise.all(pool.publish([RELAY], attestationEvent(from, to, { weight: w, hint: RELAY, createdAt: t0 })));
  }
  await new Promise((r) => setTimeout(r, 1200));

  const before = await fetchAndScore(pool, R.pubkey, "R");
  console.log("edges (before):", before.edges.join(", "));
  console.log("R=", before.scores.get(R.pubkey)?.toFixed(4), "B=", before.scores.get(B.pubkey)?.toFixed(4), "C=", before.scores.get(C.pubkey)?.toFixed(4));
  assert.ok(before.edges.some((e) => e.includes("->" + B.pubkey.slice(0, 4))), "R->B edge should exist");

  // Revoke R->B: same d, w=0, later created_at -> replaces the old revision.
  const t1 = Math.floor(Date.now() / 1000) + 1;
  await Promise.all(pool.publish([RELAY], attestationEvent(R, B, { weight: 0, hint: RELAY, createdAt: t1 })));
  await new Promise((r) => setTimeout(r, 1200));

  // Relay-level: exactly one event for that d, with w=0.
  const raw = await pool.querySync([RELAY], { kinds: [ATTESTATION_KIND], authors: [R.pubkey], "#d": [`tg:v1:${CONTEXT}:${B.pubkey}`] });
  const wOf = (ev: { tags: string[][] }) => ev.tags.find((t) => t[0] === "w")?.[1];
  console.log(`relay revisions for R->B d-tag: ${raw.length}, w=${raw.map(wOf).join(",")}`);
  assert.equal(raw.length, 1, "relay must keep only the latest revision");
  assert.equal(wOf(raw[0]!), "0", "latest revision is the w=0 revoke");

  const after = await fetchAndScore(pool, R.pubkey, "R");
  console.log("edges (after): ", after.edges.join(", "));
  console.log("R=", after.scores.get(R.pubkey)?.toFixed(4), "B=", after.scores.get(B.pubkey)?.toFixed(4), "C=", after.scores.get(C.pubkey)?.toFixed(4));
  assert.ok(!after.edges.some((e) => e.includes("->" + B.pubkey.slice(0, 4))), "R->B edge must be gone");
  assert.equal(after.scores.get(B.pubkey) ?? 0, 0, "B must be unreachable after revoke");
  assert.ok((after.scores.get(C.pubkey) ?? 0) > 0, "C stays reachable via R->C");
  assert.ok((before.scores.get(B.pubkey) ?? 0) > 0, "sanity: B had a score before");

  pool.close([RELAY]);
  console.log("REVOKE E2E PASS");
}

main().catch((e) => {
  console.error("REVOKE E2E FAIL:", e);
  process.exit(1);
});
