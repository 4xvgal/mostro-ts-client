// Bun adapter — runs the shared storage contract against bun:sqlite.
import { test } from "bun:test";
import { openBunSqliteStore } from "../../src/protocol/bun-store.js";
import { storageContract } from "../storage.contract.js";

const assert = {
  equal: (actual: unknown, expected: unknown, msg?: string) => {
    if (actual !== expected) throw new Error(msg ?? `expected ${expected}, got ${actual}`);
  },
  ok: (value: unknown, msg?: string) => {
    if (!value) throw new Error(msg ?? "expected truthy");
  },
};

storageContract({ test, assert }, () => openBunSqliteStore());