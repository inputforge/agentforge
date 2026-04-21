import type { Migration } from "../migrator.ts";

export default {
  name: "006_add_agent_output",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_output (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT    NOT NULL,
        data       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      )
    `);

    db.run("CREATE INDEX IF NOT EXISTS idx_agent_output_agent_id_id ON agent_output(agent_id, id)");
  },
} satisfies Migration;
