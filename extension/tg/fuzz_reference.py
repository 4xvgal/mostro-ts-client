#!/usr/bin/env python3
"""L0 reference: recompute computePpr scores with networkx nx.pagerank and
diff against the TS candidate written by fuzz.ts.

  python extension/tg/fuzz_reference.py [extension/tg/out/fuzz.json]
"""
import json
import sys

import networkx as nx

PATH = sys.argv[1] if len(sys.argv) > 1 else "extension/tg/out/fuzz.json"
TOL = 1e-6

data = json.load(open(PATH))
alpha = data["alpha"]
worst = 0.0
worst_case = -1

for i, c in enumerate(data["cases"]):
    G = nx.DiGraph()
    G.add_nodes_from(c["nodes"])
    for u, v, w in c["edges"]:
        if G.has_edge(u, v):
            G[u][v]["weight"] += w
        else:
            G.add_edge(u, v, weight=w)

    try:
        ref = nx.pagerank(
            G, alpha=alpha, personalization={c["root"]: 1.0},
            weight="weight", tol=1e-12, max_iter=5000,
        )
    except nx.PowerIterationFailedConvergence:
        ref = nx.pagerank(
            G, alpha=alpha, personalization={c["root"]: 1.0},
            weight="weight", tol=1e-10, max_iter=50000,
        )

    total = sum(c["ts"])
    if abs(total - 1.0) > 1e-9:
        print(f"case {i}: TS scores sum to {total} (must be 1)")
        sys.exit(1)

    diff = max(abs(ref[node] - c["ts"][k]) for k, node in enumerate(c["nodes"]))
    if diff > worst:
        worst, worst_case = diff, i

    if diff > TOL:
        print(f"MISMATCH case {i}: max|TS-nx| = {diff:.3e}")
        print("  root:", c["root"])
        print("  edges:", c["edges"])
        print("  ts :", c["ts"])
        print("  ref:", [ref[node] for node in c["nodes"]])
        sys.exit(1)

print(f"L0 PASS: {len(data['cases'])} cases, worst |TS-nx| = {worst:.3e} (case {worst_case})")
