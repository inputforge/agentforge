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
  constructor(private readonly adapter: DatabaseAdapter) {}

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
      if (applied.has(migration.name)) continue;
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
// SQLite adapter (bun:sqlite)
// ---------------------------------------------------------------------------

import type { Database, SQLQueryBindings } from "bun:sqlite";

export class SqliteAdapter implements DatabaseAdapter {
  constructor(private readonly db: Database) {}

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as SQLQueryBindings[]));
  }

  query<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as SQLQueryBindings[])) as T[];
  }

  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }
}
