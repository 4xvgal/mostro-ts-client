// Node SQLite store — node:sqlite (Node 22+).
// Import from "mostro-ts-client/node".

import { DatabaseSync } from "node:sqlite";
import { createSqliteStore } from "./sqlite.js";
import type { SqlDatabase } from "./sqlite.js";

const openNodeSqlite = (path: string): SqlDatabase =>
  new DatabaseSync(path) as unknown as SqlDatabase;

/** Open a SQLite-backed Store on Node. */
export const openNodeSqliteStore = createSqliteStore(openNodeSqlite);
export type { SqlDatabase };