import type { Migration } from "../migrator.ts";

export default {
  name: "011_add_archive",
  up(db) {
    db.run("ALTER TABLE tickets ADD COLUMN archived_at INTEGER DEFAULT NULL");
  },
} satisfies Migration;
