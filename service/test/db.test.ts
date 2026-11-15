import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      assert.deepEqual(await migrate(db), ["0001_init.sql", "0002_settle_lease.sql", "0003_final_void_check.sql", "0004_payment_claims.sql"]);
      assert.deepEqual(await migrate(db), []);
      assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n"), 4);
    } finally {
      db.close();
    }
  });

  it("0003 and 0004 on a database in use: btc-final batches are checked again, and payments on record claim their authorization", async () => {
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    const db = new SqliteD1(":memory:");
    try {
      for (const file of ["0001_init.sql", "0002_settle_lease.sql"]) copyFileSync(join(MIGRATIONS_DIR, file), join(before, file));
      await migrate(db, before);
      const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
      const batch = (id: number, stage: string) =>
        db.prepare(`INSERT INTO batches (id, root, mode, count, schema_version, state, stage, next_check_at, created_at, updated_at) VALUES (?, ?, 'batch', 1, 1, 'mined', ?, NULL, 1, 1)`).bind(id, hex(id), stage).run();
      await batch(1, "btc-final");
      await batch(2, "voided");
      const receipt = (n: number, created: number, payment: unknown) =>
        db
          .prepare(
            `INSERT INTO receipts (run_id, leaf, manifest_hash, agent, principal, schema_version, agent_signature, mode, state, payment_json, created_at, updated_at)
             VALUES (?, ?, ?, '0xa', '0xa', 1, '0x', 'batch', 'unpaid', ?, ?, ?)`,
          )
          .bind(hex(n), hex(n + 100), hex(n + 200), payment === null ? null : JSON.stringify(payment), created, created)
          .run();
      const auth = { transferMethod: "permit2", asset: "0xAsset", payer: "0xPayer", nonce: "42", status: "settlement_unknown" };
      await receipt(1, 20, auth); // created later, same authorization
      await receipt(2, 10, auth); // created first: keeps it
      await receipt(3, 30, { ...auth, nonce: "43" });
      await receipt(4, 40, { status: "settlement_unknown" }); // no authorization on record
      await receipt(5, 50, null);

      assert.deepEqual(await migrate(db), ["0003_final_void_check.sql", "0004_payment_claims.sql"]);
      const checks = (await db.prepare("SELECT id, next_check_at FROM batches ORDER BY id").all<{ id: number; next_check_at: number | null }>()).results;
      assert.ok(checks[0]!.next_check_at! > Date.now() - 60_000, "the btc-final batch is due for a void check");
      assert.equal(checks[1]!.next_check_at, null, "a voided batch stays unchecked");
      const claims = (await db.prepare("SELECT payment_key, run_id FROM payment_claims ORDER BY payment_key").all<{ payment_key: string; run_id: string }>()).results;
      assert.deepEqual(claims, [
        { payment_key: "permit2:0xasset:0xpayer:42", run_id: hex(2) },
        { payment_key: "permit2:0xasset:0xpayer:43", run_id: hex(3) },
      ]);
      // The service's own key for the same authorization finds the claim.
      const store = new Store(db);
      assert.equal(await store.claimPayment("permit2:0xasset:0xpayer:42", hex(1) as `0x${string}`, Date.now()), hex(2));
      assert.equal(await store.claimPayment("permit2:0xasset:0xpayer:44", hex(1) as `0x${string}`, Date.now()), hex(1));
    } finally {
      db.close();
      rmSync(before, { recursive: true, force: true });
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
