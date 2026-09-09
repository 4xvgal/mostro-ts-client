// Browser adapter — runs the shared storage contract against IndexedDB
// (fake-indexeddb in Node, real IndexedDB in the browser).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openIndexedDbStore } from "../../src/protocol/idb.js";
import { storageContract } from "../storage.contract.js";

before(async () => {
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  // @ts-expect-error installing global IndexedDB for the store under test
  globalThis.indexedDB = indexedDB;
  // @ts-expect-error IDBKeyRange used by fake-indexeddb internally
  globalThis.IDBKeyRange = IDBKeyRange;
});

storageContract({ test, assert }, () =>
  openIndexedDbStore({ dbName: `test-${Date.now()}-${Math.random()}` }),
);