import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { migrate, MIGRATIONS_DIR, splitSql, SqliteD1 } from "../src/db.js";
import { Store } from "../src/store.js";
import { tempDbPath } from "./helpers.js";

describe("D1-shaped database adapter", () => {
  it("migrations are plain SQL that D1 accepts: no PRAGMAs, transactions, ATTACH or extensions", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    assert.ok(files.includes("0001_init.sql"));
    for (const file of files) {
      for (const statement of splitSql(readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8"))) {
        assert.match(statement, /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE|INSERT|UPDATE|DROP)/i, `${file}: ${statement.slice(0, 60)}`);
        assert.doesNotMatch(statement, /\b(PRAGMA|BEGIN|COMMIT|ROLLBACK|ATTACH|load_extension|STRICT)\b/i, `${file}: ${statement.slice(0, 60)}`);
      }
    }
  });

  it("applies migrations once and records them in d1_migrations", async () => {
    const db = new SqliteD1(":memory:");
    try {
      assert.deepEqual(await migrate(db), ["0001_init.sql", "0002_settle_lease.sql"]);
      assert.deepEqual(await migrate(db), []);
      assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n"), 2);
    } finally {
      db.close();
    }
  });

  it("behaves like D1: bind/first/all/run, batch is all-or-nothing, undefined is refused", async () => {
    const path = tempDbPath();
    const db = new SqliteD1(path.path);
    try {
      await migrate(db);
      const store = new Store(db);
      await store.setState("k", "v1", 1);
      assert.equal(await store.getState("k"), "v1");
      const run = await db.prepare("UPDATE service_state SET value = ? WHERE key = ?").bind("v2", "k").run();
      assert.equal(run.meta.changes, 1);
      const all = await db.prepare("SELECT key, value FROM service_state").all<{ key: string; value: string }>();
      assert.deepEqual(all.results, [{ key: "k", value: "v2" }]);

      await assert.rejects(
        db.batch([
          db.prepare("UPDATE service_state SET value = ? WHERE key = ?").bind("v3", "k"),
          db.prepare("INSERT INTO service_state (key, value, updated_at) VALUES (?, ?, ?)").bind("k", "dup", 1),
        ]),
        /UNIQUE/,
      );
      assert.equal(await store.getState("k"), "v2", "the first statement was rolled back");
      assert.throws(() => db.prepare("SELECT ?").bind(undefined as never), /D1_TYPE_ERROR/);
    } finally {
      db.close();
      path.cleanup();
    }
  });
});
