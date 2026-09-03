import type { Migration } from "../migrator.ts";

/**
 * Which tickets must land before which.
 *
 * A join table rather than a `depends_on` column on `tickets`: a unit can need more than one
 * prerequisite, and real FKs mean deleting a ticket cleans up its edges for free instead of
 * leaving dangling ids behind. `PRAGMA foreign_keys` is ON (see database.ts), so this is
 * enforced rather than decorative.
 *
 * CREATE TABLE, not ALTER — SQLite cannot drop a NOT NULL, and rebuilding `tickets` would
 * mean dropping it, which with FKs enabled fires an implicit DELETE and would cascade away
 * every `diff_comments` row.
 *
 * Both directions cascade: if either endpoint is deleted the edge is meaningless.
 */
export default {
  name: "012_add_ticket_dependencies",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS ticket_dependencies (
        ticket_id            TEXT NOT NULL,
        depends_on_ticket_id TEXT NOT NULL,
        PRIMARY KEY (ticket_id, depends_on_ticket_id),
        FOREIGN KEY (ticket_id)            REFERENCES tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
        CHECK (ticket_id <> depends_on_ticket_id)
      )
    `);
    // "What is unblocked now that X landed?" is the question auto-start will ask on every
    // merge, and the PK only indexes the other direction.
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_ticket_dependencies_depends_on
        ON ticket_dependencies (depends_on_ticket_id)
    `);
  },
} satisfies Migration;
