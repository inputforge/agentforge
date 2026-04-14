import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

const DB_PATH = join(process.cwd(), "data/agentforge.db");
mkdirSync(join(process.cwd(), "data"), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    agent_id TEXT,
    worktree TEXT,
    branch TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'claude-code',
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    pid INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    needs_input INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS remote_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    repo_url TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    local_path TEXT NOT NULL
  );
`);

// Migrations — add columns that didn't exist in earlier schema versions
{
  const cols = db.prepare("PRAGMA table_info(tickets)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "agent_title")) {
    db.exec("ALTER TABLE tickets ADD COLUMN agent_title TEXT");
  }
}

// Prepared statements

export const ticketStmts = {
  list: db.prepare(`
    SELECT id, title, description, status,
           agent_id as agentId, worktree, branch,
           agent_title as agentTitle,
           created_at as createdAt, updated_at as updatedAt
    FROM tickets ORDER BY created_at DESC
  `),
  get: db.prepare(`
    SELECT id, title, description, status,
           agent_id as agentId, worktree, branch,
           agent_title as agentTitle,
           created_at as createdAt, updated_at as updatedAt
    FROM tickets WHERE id = ?
  `),
  insert: db.prepare(`
    INSERT INTO tickets (id, title, description, status, created_at, updated_at)
    VALUES ($id, $title, $description, $status, $createdAt, $updatedAt)
  `),
  updateStatus: db.prepare(`
    UPDATE tickets SET status = $status, updated_at = $updatedAt WHERE id = $id
  `),
  linkAgent: db.prepare(`
    UPDATE tickets SET agent_id = $agentId, branch = $branch, worktree = $worktree, updated_at = $updatedAt
    WHERE id = $ticketId
  `),
  updateTitle: db.prepare(
    `UPDATE tickets SET title = $title, updated_at = $updatedAt WHERE id = $id`,
  ),
  updateAgentTitle: db.prepare(
    `UPDATE tickets SET agent_title = $agentTitle, updated_at = $updatedAt WHERE id = $id`,
  ),
  delete: db.prepare(`DELETE FROM tickets WHERE id = ?`),
};

export const agentStmts = {
  get: db.prepare(`
    SELECT id, ticket_id as ticketId, type, command, status,
           worktree_path as worktreePath, branch, pid,
           started_at as startedAt, ended_at as endedAt,
           needs_input as needsInput
    FROM agents WHERE id = ?
  `),
  listByTicket: db.prepare(`
    SELECT id, ticket_id as ticketId, type, command, status,
           worktree_path as worktreePath, branch, pid,
           started_at as startedAt, ended_at as endedAt,
           needs_input as needsInput
    FROM agents WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1
  `),
  listRunning: db.prepare(`
    SELECT id, ticket_id as ticketId, type, command, status,
           worktree_path as worktreePath, branch, pid,
           started_at as startedAt, ended_at as endedAt,
           needs_input as needsInput
    FROM agents WHERE status IN ('running', 'waiting-input', 'waiting-permission')
  `),
  insert: db.prepare(`
    INSERT INTO agents (id, ticket_id, type, command, status, worktree_path, branch, started_at, needs_input)
    VALUES ($id, $ticketId, $type, $command, $status, $worktreePath, $branch, $startedAt, $needsInput)
  `),
  updateStatus: db.prepare(`
    UPDATE agents SET status = $status, needs_input = $needsInput, ended_at = $endedAt WHERE id = $id
  `),
  updatePid: db.prepare(`UPDATE agents SET pid = $pid WHERE id = $id`),
};

export const remoteStmts = {
  get: db.prepare(
    `SELECT repo_url as repoUrl, base_branch as baseBranch, local_path as localPath FROM remote_config WHERE id = 1`,
  ),
  upsert: db.prepare(`
    INSERT INTO remote_config (id, repo_url, base_branch, local_path) VALUES (1, $repoUrl, $baseBranch, $localPath)
    ON CONFLICT(id) DO UPDATE SET repo_url = excluded.repo_url, base_branch = excluded.base_branch, local_path = excluded.local_path
  `),
};
