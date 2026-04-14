import type { Migration } from "../migrator.ts";

export default {
  name: "003_add_session_id",
  up(db) {
    const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('agents')");
    if (!cols.some((c) => c.name === "session_id")) {
      db.run("ALTER TABLE agents ADD COLUMN session_id TEXT");
    }
  },
} satisfies Migration;
