import type { Migration } from "../migrator.ts";

export default {
  name: "007_add_claude_state",
  up(db) {
    const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('agents')");
    if (!cols.some((c) => c.name === "claude_state")) {
      db.run("ALTER TABLE agents ADD COLUMN claude_state TEXT");
    }
  },
} satisfies Migration;
