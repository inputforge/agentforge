import type { Migration } from "../migrator.ts";

export default {
  name: "008_add_acp_state",
  up(db) {
    const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('agents')");
    if (!cols.some((c) => c.name === "acp_state")) {
      db.run("ALTER TABLE agents ADD COLUMN acp_state TEXT");
    }
  },
} satisfies Migration;
