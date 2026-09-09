// Bun SQLite store — bun:sqlite (built-in).
// Import from "mostro-ts-client/bun".
/// <reference types="bun" />

import { Database } from "bun:sqlite";
import { createSqliteStore } from "./sqlite.js";
import type { SqlDatabase } from "./sqlite.js";

const openBunSqlite = (path: string): SqlDatabase => new Database(path) as unknown as SqlDatabase;

/** Open a SQLite-backed Store on Bun. */
export const openBunSqliteStore = createSqliteStore(openBunSqlite);
export type { SqlDatabase };