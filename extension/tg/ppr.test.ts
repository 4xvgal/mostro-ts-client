// Offline unit checks for the trust-graph extension. No relay, no docker.
//   npx tsx --test extension/tg/ppr.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { computePpr, type Adjacency } from "./ppr.js";

const REL = 1e-9;

// Frozen reference vector: 5-node graph from the spec review.
//   R->B 50, R->C 50, B->D 100, C->D 50, C->E 50, root=R, alpha=0.8,
//   dangling (D,E) restart at root. Matches nx.pagerank(weight='weight').
const FIVE_NODE: Adjacency = new Map([
  ["R", [{ to: "B", weight: 50 }, { to: "C", weight: 50 }]],
  ["B", [{ to: "D", weight: 100 }]],
  ["C", [{ to: "D", weight: 50 }, { to: "E", weight: 50 }]],
]);
// Converged values (tol 1e-12). nx.pagerank's default tol=1e-6 stops early and
// prints ~1e-6 lower; we test against the fixed point, not that stopping bias.
const EXPECTED: Record<string, number> = {
  R: 0.409836065574,
  D: 0.196721311475,
  B: 0.163934426230,
  C: 0.163934426230,
  E: 0.065573770492,
};

test("5-node PPR matches frozen alpha=0.8 vector and sums to 1", () => {
  const scores = computePpr(FIVE_NODE, "R", { alpha: 0.8 });
  let sum = 0;
  for (const [node, want] of Object.entries(EXPECTED)) {
    const got = scores.get(node);
    assert.ok(got !== undefined, `missing ${node}`);
    assert.ok(Math.abs(got - want) < REL, `${node}: ${got} != ${want}`);
    sum += got;
  }
  assert.ok(Math.abs(sum - 1) < REL, `scores sum to ${sum}`);
});

test("weight scale does not matter under row-normalization (50/100 == 0.5/1)", () => {
  const scaled: Adjacency = new Map([
    ["R", [{ to: "B", weight: 0.5 }, { to: "C", weight: 0.5 }]],
    ["B", [{ to: "D", weight: 1 }]],
    ["C", [{ to: "D", weight: 0.5 }, { to: "E", weight: 0.5 }]],
  ]);
  const a = computePpr(FIVE_NODE, "R", { alpha: 0.8 });
  const b = computePpr(scaled, "R", { alpha: 0.8 });
  for (const n of ["R", "B", "C", "D", "E"]) {
    assert.ok(Math.abs(a.get(n)! - b.get(n)!) < REL, `mismatch at ${n}`);
  }
});

test("dangling mass restarts at root: D (2 paths) outranks leaf E", () => {
  const s = computePpr(FIVE_NODE, "R", { alpha: 0.8 });
  assert.ok(s.get("D")! > s.get("E")!, "D should outrank E");
  assert.ok(s.get("D")! > s.get("B")!, "D (multi-path) should outrank B");
});

test("isolated root still returns itself with score 1", () => {
  const s = computePpr(new Map(), "R", { alpha: 0.8 });
  assert.ok(Math.abs(s.get("R")! - 1) < REL);
});

