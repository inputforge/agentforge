import type { Migration } from "../migrator.ts";

export default {
  name: "006_add_ticket_base_branch",
  up(db) {
    db.run(`ALTER TABLE tickets ADD COLUMN base_branch TEXT`);
  },
} satisfies Migration;
