import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * A tiny async database API shaped like Cloudflare D1 (`prepare(sql).bind(...).run() /
 * first() / all()`, `batch([...])`), implemented on node:sqlite. Everything the service
 * does goes through this interface, so a D1 binding can replace `SqliteD1` unchanged.
 *
 * Like D1, `batch()` runs its statements in one transaction: all or nothing.
 */
export type D1Value = string | number | bigint | boolean | null | Uint8Array;

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration: number;
}

export interface D1Result<T = Record<string, unknown>> {
  success: true;
  results: T[];
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

/** Statements that hand back rows: SELECT/WITH, or anything with RETURNING. */
const RETURNS_ROWS = /^\s*(select|with|values|pragma)\b|\breturning\b/i;

function toSqlite(value: D1Value, index: number): SQLInputValue {
  if (value === undefined) throw new TypeError(`D1_TYPE_ERROR: bind parameter ${index + 1} is undefined`);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly db: SqliteD1,
    readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    return new SqliteStatement(this.db, this.sql, values.map(toSqlite));
  }

  /** Synchronous execution; used by `batch()` inside its transaction. */
  execute<T>(): D1Result<T> {
    const started = performance.now();
    const statement = this.db.statement(this.sql);
    if (RETURNS_ROWS.test(this.sql)) {
      // node:sqlite rows have a null prototype; D1 hands back plain objects.
      const results = statement.all(...this.params).map((row) => ({ ...row })) as T[];
      return { success: true, results, meta: { changes: 0, last_row_id: 0, duration: performance.now() - started } };
    }
    const info = statement.run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), duration: performance.now() - started },
    };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.statement(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (column !== undefined) return (row[column] ?? null) as T | null;
    return { ...row } as T;
  }

  async all<T>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }
}

export class SqliteD1 implements D1Database {
  readonly sqlite: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    // Connection settings live here, not in migrations (D1 refuses PRAGMAs there and sets
    // its own). FULL sync: the batcher relies on "persisted before broadcast".
    if (path !== ":memory:") this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  }

  /** Cached prepared statement for `sql`. */
  statement(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.sqlite.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  prepare(sql: string): D1PreparedStatement {
    return new SqliteStatement(this, sql);
  }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement)) throw new TypeError("batch() takes statements from this database");
        return statement.execute<T>();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.sqlite.exec(sql);
    return { count: sql.split(";").filter((s) => s.trim()).length, duration: performance.now() - started };
  }

  close(): void {
    this.cache.clear();
    this.sqlite.close();
  }
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Applies `migrations/*.sql` in name order, once each, recording them in `d1_migrations`
 * (the table wrangler uses, so `wrangler d1 migrations apply` sees the same history).
 */
export async function migrate(db: D1Database, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
  );
  const applied = new Set(
    (await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>()).results.map((row) => row.name),
  );
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(`${dir}/${name}`, "utf8");
    const statements = splitSql(sql).map((statement) => db.prepare(statement));
    statements.push(db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name));
    await db.batch(statements);
    ran.push(name);
  }
  return ran;
}

/** Splits a migration file into statements: drops `--` comments, splits on `;`. */
export function splitSql(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
  return withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}
