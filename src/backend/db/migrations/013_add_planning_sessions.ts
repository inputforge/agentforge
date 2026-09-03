import type { Migration } from "../migrator.ts";

/**
 * Interactive planning sessions — the conversation that produces tickets.
 *
 * Its own table rather than a row in `agents`, because an `agents` row cannot exist without a
 * ticket: `ticket_id` is NOT NULL with an FK to `tickets`, and a planning session has no
 * ticket by definition — it is what produces them. Making that column nullable would mean
 * rebuilding `agents`, and `DROP TABLE agents` with `PRAGMA foreign_keys` ON fires an
 * implicit DELETE that cascades through `diff_comments.agent_id` and destroys every review
 * comment in the database. Not worth it to relax one constraint.
 *
 * Deliberately not modelled as an agent despite the overlap: no worktree, no branch, no
 * merge, no exit-to-review. It runs in the repo root in plan mode (read-only) and its only
 * output is `plan`.
 *
 * `state` holds the serialised ACP conversation so a restart does not throw away a session
 * that spent minutes reading the codebase. `plan` holds the markdown from ExitPlanMode, and
 * `plan_file_path` points at the copy Claude writes under ~/.claude/plans — kept because it
 * is editable by hand and outlives this row.
 */
export default {
  name: "013_add_planning_sessions",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS planning_sessions (
        id             TEXT    PRIMARY KEY,
        cwd            TEXT    NOT NULL,
        acp_session_id TEXT,
        status         TEXT    NOT NULL DEFAULT 'idle',
        state          TEXT,
        plan           TEXT,
        plan_file_path TEXT,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER
      )
    `);
  },
} satisfies Migration;
