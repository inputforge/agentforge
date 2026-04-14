import type { Migration } from "../migrator.ts";

export default {
  name: "002_add_agent_title",
  up(db) {
    const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('tickets')");
    if (!cols.some((c) => c.name === "agent_title")) {
      db.run("ALTER TABLE tickets ADD COLUMN agent_title TEXT");
    }
  },
} satisfies Migration;
