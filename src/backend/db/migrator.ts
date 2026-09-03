/**
 * Minimal migration framework.
 *
 * Migrations are TypeScript functions that receive a DatabaseAdapter, making
 * them testable and independent of any specific database driver.
 */

export interface DatabaseAdapter {
  /** Execute a statement that returns no rows (DDL, INSERT, UPDATE, DELETE). */
  run(sql: string, ...params: unknown[]): void;
  /** Execute a query and return all matching rows. */
  query<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Wrap a set of operations in a transaction. */
  transaction(fn: () => void): void;
}

export interface Migration {
  /** Unique, sortable identifier — use a numeric prefix like "001_" to enforce order. */
  name: string;
  up(db: DatabaseAdapter): void;
}

export class MigrationRunner {
  private readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  run(migrations: Migration[]): void {
    this.adapter.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT    PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const applied = new Set(
      this.adapter.query<{ name: string }>("SELECT name FROM _migrations").map((r) => r.name),
    );

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        continue;
      }
      this.adapter.transaction(() => {
        migration.up(this.adapter);
        this.adapter.run(
          "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
          migration.name,
          Date.now(),
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite adapter (node:sqlite)
// ---------------------------------------------------------------------------

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export class SqliteAdapter implements DatabaseAdapter {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as SQLInputValue[]));
  }

  query<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  /**
   * node:sqlite has no `db.transaction()` helper, so the BEGIN/COMMIT/ROLLBACK cycle
   * is driven by hand.
   */
  transaction(fn: () => void): void {
    // SQLite has no nested transactions; join the enclosing one instead, so the
    // outermost caller keeps control of COMMIT/ROLLBACK.
    if (this.db.isTransaction) {
      fn();
      return;
    }

    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        // Some errors (e.g. SQLITE_FULL) make SQLite roll back on its own, which
        // would make an unconditional ROLLBACK throw "no transaction is active"
        // and mask the real failure.
        if (this.db.isTransaction) {
          this.db.exec("ROLLBACK");
        }
      } catch {
        // Rolling back failed; the original error below is the useful one.
      }
      throw error;
    }
  }
}
