import { afterAll } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { initDb, type DbInstances } from "./store/db.ts";
import { initQueries, type StoreQueries } from "./store/queries.ts";

/**
 * Test scaffold: a throwaway directory of real SQLite stores, removed when
 * the test file finishes. Call at the top of a test file, then
 * `freshStore("name.db")` wherever a test needs its own empty database.
 */
export function tempStores(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    freshStore(name: string): { db: DbInstances; store: StoreQueries } {
      const db = initDb(join(dir, name));
      return { db, store: initQueries(db) };
    },
  };
}
