import type { Migration } from "../migrator.ts";

export default {
  name: "001_baseline",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS tickets (
        id          TEXT    PRIMARY KEY,
        title       TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'backlog',
        agent_id    TEXT,
        worktree    TEXT,
        branch      TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id           TEXT    PRIMARY KEY,
        ticket_id    TEXT    NOT NULL,
        type         TEXT    NOT NULL DEFAULT 'claude-code',
        command      TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'running',
        worktree_path TEXT   NOT NULL,
        branch       TEXT    NOT NULL,
        pid          INTEGER,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        needs_input  INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS remote_config (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        repo_url    TEXT    NOT NULL,
        base_branch TEXT    NOT NULL DEFAULT 'main',
        local_path  TEXT    NOT NULL
      )
    `);
  },
} satisfies Migration;
