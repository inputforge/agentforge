import type { Migration } from "../migrator.ts";

export default {
  name: "010_add_diff_comments",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS diff_comments (
        id          TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        file_path   TEXT NOT NULL,
        side        TEXT NOT NULL DEFAULT 'additions',
        start_line  INTEGER NOT NULL DEFAULT 0,
        end_line    INTEGER NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);
  },
} satisfies Migration;
