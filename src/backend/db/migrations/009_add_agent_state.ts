import type { Migration } from "../migrator.ts";

export default {
  name: "009_add_agent_state",
  up(db) {
    const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('agents')");
    const colNames = new Set(cols.map((c) => c.name));

    if (!colNames.has("agent_state")) {
      db.run("ALTER TABLE agents ADD COLUMN agent_state TEXT");
    }
    if (colNames.has("claude_state")) {
      db.run("ALTER TABLE agents DROP COLUMN claude_state");
    }
    if (colNames.has("acp_state")) {
      db.run("ALTER TABLE agents DROP COLUMN acp_state");
    }
  },
} satisfies Migration;
