import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";
import { MigrationRunner, SqliteAdapter } from "./migrator.ts";
import { migrations } from "./migrations/index.ts";
import type { Agent, RemoteConfig, Ticket } from "../../common/types.ts";

const BASE_PATH = process.env.REPO_PATH ?? process.cwd();
const DB_PATH = join(BASE_PATH, ".agentforge/data/agentforge.db");
mkdirSync(join(BASE_PATH, ".agentforge/data"), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

export function initDb(): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 10000;");

  const runner = new MigrationRunner(new SqliteAdapter(db));
  runner.run(migrations);
}

type RawTicket = {
  id: string;
  title: string;
  description: string;
  status: string;
  baseBranch: string | null;
  agentId: string | null;
  worktree: string | null;
  branch: string | null;
  agentTitle: string | null;
  createdAt: number;
  updatedAt: number;
};

type RawAgent = {
  id: string;
  ticketId: string;
  type: string;
  command: string;
  status: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  sessionId: string | null;
};

const TICKET_COLS = `
  id, title, description, status,
  base_branch AS baseBranch,
  agent_id    AS agentId,
  worktree,
  branch,
  agent_title AS agentTitle,
  created_at  AS createdAt,
  updated_at  AS updatedAt
`;

const AGENT_COLS = `
  id,
  ticket_id    AS ticketId,
  type, command, status,
  worktree_path AS worktreePath,
  branch,
  base_branch  AS baseBranch,
  pid,
  started_at   AS startedAt,
  ended_at     AS endedAt,
  session_id   AS sessionId
`;

function mapTicket(row: RawTicket): Ticket {
  return { ...row, status: row.status as Ticket["status"] };
}

function mapAgent(row: RawAgent): Agent {
  return {
    ...row,
    type: row.type as Agent["type"],
    status: row.status as Agent["status"],
  };
}

export const ticketStmts = {
  list: {
    all: (): Ticket[] =>
      db
        .query<RawTicket, []>(`SELECT ${TICKET_COLS} FROM tickets ORDER BY created_at DESC`)
        .all()
        .map(mapTicket),
  },
  get: {
    get: (id: string): Ticket | null => {
      const row = db
        .query<RawTicket, [string]>(`SELECT ${TICKET_COLS} FROM tickets WHERE id = ?`)
        .get(id);
      return row ? mapTicket(row) : null;
    },
  },
  insert: {
    run: (args: {
      $id: string;
      $title: string;
      $description: string;
      $status: string;
      $baseBranch: string | null;
      $createdAt: number;
      $updatedAt: number;
    }): void => {
      db.query(
        `INSERT INTO tickets (id, title, description, status, base_branch, created_at, updated_at)
         VALUES ($id, $title, $description, $status, $baseBranch, $createdAt, $updatedAt)`,
      ).run(args);
    },
  },
  updateStatus: {
    run: (args: { $status: string; $updatedAt: number; $id: string }): void => {
      db.query("UPDATE tickets SET status = $status, updated_at = $updatedAt WHERE id = $id").run(
        args,
      );
    },
  },
  linkAgent: {
    run: (args: {
      $agentId: string;
      $branch: string;
      $worktree: string;
      $updatedAt: number;
      $ticketId: string;
    }): void => {
      db.query(
        `UPDATE tickets
         SET agent_id = $agentId, branch = $branch, worktree = $worktree, updated_at = $updatedAt
         WHERE id = $ticketId`,
      ).run(args);
    },
  },
  updateTitle: {
    run: (args: { $title: string; $updatedAt: number; $id: string }): void => {
      db.query("UPDATE tickets SET title = $title, updated_at = $updatedAt WHERE id = $id").run(
        args,
      );
    },
  },
  updateAgentTitle: {
    run: (args: { $agentTitle: string; $updatedAt: number; $id: string }): void => {
      db.query(
        "UPDATE tickets SET agent_title = $agentTitle, updated_at = $updatedAt WHERE id = $id",
      ).run(args);
    },
  },
  updateBaseBranch: {
    run: (args: { $baseBranch: string; $updatedAt: number; $id: string }): void => {
      db.query(
        "UPDATE tickets SET base_branch = $baseBranch, updated_at = $updatedAt WHERE id = $id",
      ).run(args);
    },
  },
  delete: {
    run: (id: string): void => {
      db.query<void, [string]>("DELETE FROM tickets WHERE id = ?").run(id);
    },
  },
};

export const agentStmts = {
  get: {
    get: (id: string): Agent | null => {
      const row = db
        .query<RawAgent, [string]>(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`)
        .get(id);
      return row ? mapAgent(row) : null;
    },
  },
  listByTicket: {
    all: (ticketId: string): Agent[] =>
      db
        .query<RawAgent, [string]>(
          `SELECT ${AGENT_COLS} FROM agents WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1`,
        )
        .all(ticketId)
        .map(mapAgent),
  },
  listRunning: {
    all: (): Agent[] =>
      db
        .query<RawAgent, []>(`SELECT ${AGENT_COLS} FROM agents WHERE status = 'running'`)
        .all()
        .map(mapAgent),
  },
  insert: {
    run: (args: {
      $id: string;
      $ticketId: string;
      $type: string;
      $command: string;
      $status: string;
      $worktreePath: string;
      $branch: string;
      $baseBranch: string;
      $startedAt: number;
    }): void => {
      db.query(
        `INSERT INTO agents (id, ticket_id, type, command, status, worktree_path, branch, base_branch, started_at)
         VALUES ($id, $ticketId, $type, $command, $status, $worktreePath, $branch, $baseBranch, $startedAt)`,
      ).run(args);
    },
  },
  updateStatus: {
    run: (args: { $id: string; $status: string; $endedAt: number | null }): void => {
      db.query(`UPDATE agents SET status = $status, ended_at = $endedAt WHERE id = $id`).run(args);
    },
  },
  updatePid: {
    run: (args: { $pid: number; $id: string }): void => {
      db.query("UPDATE agents SET pid = $pid WHERE id = $id").run(args);
    },
  },
  updateSessionId: {
    run: (args: { $sessionId: string; $id: string }): void => {
      db.query(
        "UPDATE agents SET session_id = $sessionId WHERE id = $id AND session_id IS NULL",
      ).run(args);
    },
  },
  updateBaseBranch: {
    run: (args: { $baseBranch: string; $id: string }): void => {
      db.query("UPDATE agents SET base_branch = $baseBranch WHERE id = $id").run(args);
    },
  },
};

export const integrationStmts = {
  get: (provider: string, key: string): string | null => {
    const row = db
      .query<{ value: string }, [string, string]>(
        "SELECT value FROM integration_configs WHERE provider = ? AND key = ?",
      )
      .get(provider, key);
    return row?.value ?? null;
  },
  getAll: (provider: string): Record<string, string> => {
    const rows = db
      .query<{ key: string; value: string }, [string]>(
        "SELECT key, value FROM integration_configs WHERE provider = ?",
      )
      .all(provider);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  set: (provider: string, key: string, value: string): void => {
    db.query(
      `INSERT INTO integration_configs (provider, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT (provider, key) DO UPDATE SET value = excluded.value`,
    ).run(provider, key, value);
  },
  deleteAll: (provider: string): void => {
    db.query("DELETE FROM integration_configs WHERE provider = ?").run(provider);
  },
};

export const remoteStmts = {
  get: {
    get: (): RemoteConfig | null =>
      db
        .query<RemoteConfig, []>(
          "SELECT repo_url AS repoUrl, base_branch AS baseBranch, local_path AS localPath FROM remote_config WHERE id = 1",
        )
        .get() ?? null,
  },
  upsert: {
    run: (args: { $repoUrl: string; $baseBranch: string; $localPath: string }): void => {
      db.query(
        `INSERT INTO remote_config (id, repo_url, base_branch, local_path)
         VALUES (1, $repoUrl, $baseBranch, $localPath)
         ON CONFLICT (id) DO UPDATE SET
           repo_url    = excluded.repo_url,
           base_branch = excluded.base_branch,
           local_path  = excluded.local_path`,
      ).run(args);
    },
  },
};
