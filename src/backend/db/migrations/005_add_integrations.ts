import type { Migration } from "../migrator.ts";

export default {
  name: "005_add_integrations",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS integration_configs (
        provider TEXT NOT NULL,
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (provider, key)
      )
    `);
  },
} satisfies Migration;
