import type { Migration } from "../migrator.ts";

export default {
  name: "004_add_agent_base_branch",
  up(db) {
    db.run(`ALTER TABLE agents ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'`);
  },
} satisfies Migration;
