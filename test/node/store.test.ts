// Node adapter — runs the shared storage contract against node:sqlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openNodeSqliteStore } from "../../src/protocol/node-store.js";
import { storageContract } from "../storage.contract.js";

storageContract({ test, assert }, () => openNodeSqliteStore());