import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import type { Agent, DiffComment, RemoteConfig, Ticket } from "../../common/types.ts";
import { migrations } from "./migrations/index.ts";
import { MigrationRunner, SqliteAdapter } from "./migrator.ts";

/**
 * Result of a `run()` call. Mirrors node:sqlite's `StatementResultingChanges`,
 * narrowed to `number`: that type is `number | bigint` because a statement can
 * opt into BigInt results via `setReadBigInts(true)` — we never do, so SQLite
 * counters always come back as plain numbers.
 */
export interface Changes {
  changes: number;
  lastInsertRowid: number;
}

type BindValue = SQLInputValue;

/**
 * Typed view over a node:sqlite `StatementSync`. `StatementSync` has no row
 * generics, so `q()` casts once and every call site keeps its original types.
 */
interface Stmt<Row> {
  all(namedParameters: Record<string, BindValue>): Row[];
  all(...anonymousParameters: BindValue[]): Row[];
  get(namedParameters: Record<string, BindValue>): Row | undefined;
  get(...anonymousParameters: BindValue[]): Row | undefined;
  run(namedParameters: Record<string, BindValue>): Changes;
  run(...anonymousParameters: BindValue[]): Changes;
}

let database: DatabaseSync | null = null;

/**
 * Prepared-statement cache keyed by SQL text. node:sqlite has no equivalent of
 * Bun's `db.query()`, which doubled as a statement cache keyed by SQL string;
 * preparing on every call is measurably slower, so the cache lives here instead.
 */
const stmtCache = new Map<string, StatementSync>();

function conn(): DatabaseSync {
  if (!database) {
    throw new Error("Database is not open — call initDb(repoPath) first");
  }
  return database;
}

function q<Row = unknown>(sql: string): Stmt<Row> {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = conn().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt as unknown as Stmt<Row>;
}

/**
 * Open the database under `repoPath`, apply pragmas and run migrations.
 *
 * Must be called before any statement below. Nothing in this module touches the
 * filesystem at import time: a packaged app launched from the Finder has cwd
 * `/`, so resolving the DB path at import would try to create `/.agentforge`.
 */
export function initDb(repoPath: string): void {
  if (database) {
    throw new Error("Database is already open — call closeDb() before re-opening");
  }

  const dataDir = join(repoPath, ".agentforge/data");
  mkdirSync(dataDir, { recursive: true });

  database = new DatabaseSync(join(dataDir, "agentforge.db"));

  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 10000;");

  const runner = new MigrationRunner(new SqliteAdapter(database));
  runner.run(migrations);
}

/** Close the database and drop every cached statement. */
export function closeDb(): void {
  stmtCache.clear();
  database?.close();
  database = null;
}

interface RawTicket {
  id: string;
  title: string;
  description: string;
  status: string;
  baseBranch: string | null;
  agentId: string | null;
  worktree: string | null;
  branch: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RawAgent {
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
}

/**
 * A planning session row.
 *
 * Not mapped to a `common/` domain type: `state` and `plan` are opaque blobs here (the
 * serialised ACP conversation and the plan markdown), and only PlanningService knows how to
 * read them. The renderer gets the parsed shape, not this.
 */
interface RawPlanningSession {
  id: string;
  cwd: string;
  acpSessionId: string | null;
  status: string;
  state: string | null;
  plan: string | null;
  planFilePath: string | null;
  startedAt: number;
  endedAt: number | null;
}

const TICKET_COLS = `
  id, title, description, status,
  base_branch  AS baseBranch,
  agent_id     AS agentId,
  worktree,
  branch,
  archived_at  AS archivedAt,
  created_at   AS createdAt,
  updated_at   AS updatedAt
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
    status: row.status as Agent["status"],
    type: row.type as Agent["type"],
  };
}

export const ticketStmts = {
  delete: {
    run: (id: string): void => {
      q("DELETE FROM tickets WHERE id = ?").run(id);
    },
  },
  get: {
    get: (id: string): Ticket | null => {
      const row = q<RawTicket>(`SELECT ${TICKET_COLS} FROM tickets WHERE id = ?`).get(id);
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
      q(
        `INSERT INTO tickets (id, title, description, status, base_branch, created_at, updated_at)
         VALUES ($id, $title, $description, $status, $baseBranch, $createdAt, $updatedAt)`,
      ).run(args);
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
      q(
        `UPDATE tickets
         SET agent_id = $agentId, branch = $branch, worktree = $worktree, updated_at = $updatedAt
         WHERE id = $ticketId`,
      ).run(args);
    },
  },
  archive: {
    run: (args: { $archivedAt: number; $id: string }): Changes => {
      return q(
        `UPDATE tickets
           SET archived_at = $archivedAt, updated_at = $archivedAt
           WHERE id = $id AND archived_at IS NULL`,
      ).run(args);
    },
  },
  list: {
    all: (): Ticket[] =>
      q<RawTicket>(
        `SELECT ${TICKET_COLS} FROM tickets WHERE archived_at IS NULL ORDER BY created_at DESC`,
      )
        .all()
        .map(mapTicket),
  },
  listArchived: {
    all: (): Ticket[] =>
      q<RawTicket>(
        `SELECT ${TICKET_COLS} FROM tickets WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`,
      )
        .all()
        .map(mapTicket),
  },
  unarchive: {
    run: (args: { $updatedAt: number; $id: string }): Changes => {
      return q(
        `UPDATE tickets
           SET archived_at = NULL, updated_at = $updatedAt
           WHERE id = $id AND archived_at IS NOT NULL`,
      ).run(args);
    },
  },
  updateBaseBranch: {
    run: (args: { $baseBranch: string; $updatedAt: number; $id: string }): void => {
      q("UPDATE tickets SET base_branch = $baseBranch, updated_at = $updatedAt WHERE id = $id").run(
        args,
      );
    },
  },
  updateStatus: {
    run: (args: { $status: string; $updatedAt: number; $id: string }): void => {
      q("UPDATE tickets SET status = $status, updated_at = $updatedAt WHERE id = $id").run(args);
    },
  },
  updateTitle: {
    run: (args: { $title: string; $updatedAt: number; $id: string }): void => {
      q("UPDATE tickets SET title = $title, updated_at = $updatedAt WHERE id = $id").run(args);
    },
  },
};

export const agentStmts = {
  get: {
    get: (id: string): Agent | null => {
      const row = q<RawAgent>(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`).get(id);
      return row ? mapAgent(row) : null;
    },
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
      q(
        `INSERT INTO agents (id, ticket_id, type, command, status, worktree_path, branch, base_branch, started_at)
         VALUES ($id, $ticketId, $type, $command, $status, $worktreePath, $branch, $baseBranch, $startedAt)`,
      ).run(args);
    },
  },
  /**
   * Every agent currently referenced by a live ticket — the exact set the board needs.
   *
   * Scoped to `tickets.agent_id` on non-archived tickets so it mirrors `ticketStmts.list`:
   * the two together describe one consistent working set. Not "all agents ever", which
   * would grow without bound and ship superseded agents from restarted tickets.
   */
  list: {
    all: (): Agent[] =>
      q<RawAgent>(
        `SELECT ${AGENT_COLS} FROM agents
         WHERE id IN (
           SELECT agent_id FROM tickets WHERE agent_id IS NOT NULL AND archived_at IS NULL
         )
         ORDER BY started_at DESC`,
      )
        .all()
        .map(mapAgent),
  },
  listByTicket: {
    all: (ticketId: string): Agent[] =>
      q<RawAgent>(
        `SELECT ${AGENT_COLS} FROM agents WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
        .all(ticketId)
        .map(mapAgent),
  },
  listRunning: {
    all: (): Agent[] =>
      q<RawAgent>(`SELECT ${AGENT_COLS} FROM agents WHERE status = 'running'`).all().map(mapAgent),
  },
  loadAgentState: {
    get: (id: string): string | null => {
      const row = q<{ agent_state: string | null }>(
        "SELECT agent_state FROM agents WHERE id = ?",
      ).get(id);
      return row?.agent_state ?? null;
    },
  },
  overwriteSessionId: {
    run: (args: { $sessionId: string; $id: string }): void => {
      q("UPDATE agents SET session_id = $sessionId WHERE id = $id").run(args);
    },
  },
  saveAgentState: {
    run: (args: { $id: string; $agentState: string }): void => {
      q("UPDATE agents SET agent_state = $agentState WHERE id = $id").run(args);
    },
  },
  updateBaseBranch: {
    run: (args: { $baseBranch: string; $id: string }): void => {
      q("UPDATE agents SET base_branch = $baseBranch WHERE id = $id").run(args);
    },
  },
  updatePid: {
    run: (args: { $pid: number; $id: string }): void => {
      q("UPDATE agents SET pid = $pid WHERE id = $id").run(args);
    },
  },
  updateSessionId: {
    run: (args: { $sessionId: string; $id: string }): void => {
      q("UPDATE agents SET session_id = $sessionId WHERE id = $id AND session_id IS NULL").run(
        args,
      );
    },
  },
  updateStatus: {
    run: (args: { $id: string; $status: string; $endedAt: number | null }): void => {
      q(`UPDATE agents SET status = $status, ended_at = $endedAt WHERE id = $id`).run(args);
    },
  },
};

export const integrationStmts = {
  deleteAll: (provider: string): void => {
    q("DELETE FROM integration_configs WHERE provider = ?").run(provider);
  },
  get: (provider: string, key: string): string | null => {
    const row = q<{ value: string }>(
      "SELECT value FROM integration_configs WHERE provider = ? AND key = ?",
    ).get(provider, key);
    return row?.value ?? null;
  },
  getAll: (provider: string): Record<string, string> => {
    const rows = q<{ key: string; value: string }>(
      "SELECT key, value FROM integration_configs WHERE provider = ?",
    ).all(provider);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  set: (provider: string, key: string, value: string): void => {
    q(
      `INSERT INTO integration_configs (provider, key, value)
       VALUES (?, ?, ?)
       ON CONFLICT (provider, key) DO UPDATE SET value = excluded.value`,
    ).run(provider, key, value);
  },
};

export const diffCommentStmts = {
  delete: {
    run: (id: string, agentId: string): void => {
      q("DELETE FROM diff_comments WHERE id = ? AND agent_id = ?").run(id, agentId);
    },
  },
  deleteByAgent: {
    run: (agentId: string): void => {
      q("DELETE FROM diff_comments WHERE agent_id = ?").run(agentId);
    },
  },
  insert: {
    run: (args: {
      $id: string;
      $agentId: string;
      $filePath: string;
      $side: string;
      $startLine: number;
      $endLine: number;
      $content: string;
      $createdAt: number;
    }): void => {
      q(
        `INSERT INTO diff_comments (id, agent_id, file_path, side, start_line, end_line, content, created_at)
         VALUES ($id, $agentId, $filePath, $side, $startLine, $endLine, $content, $createdAt)`,
      ).run(args);
    },
  },
  listByAgent: {
    all: (agentId: string): DiffComment[] =>
      q<DiffComment>(
        `SELECT id, agent_id AS agentId, file_path AS filePath, side,
                  start_line AS startLine, end_line AS endLine,
                  content, created_at AS createdAt
           FROM diff_comments WHERE agent_id = ? ORDER BY created_at ASC`,
      )
        .all(agentId)
        // node:sqlite rows have a null prototype; hand callers ordinary objects.
        .map((row) => Object.assign({}, row)),
  },
};

export const remoteStmts = {
  get: {
    get: (): RemoteConfig | null => {
      const row = q<RemoteConfig>(
        "SELECT repo_url AS repoUrl, base_branch AS baseBranch, local_path AS localPath FROM remote_config WHERE id = 1",
      ).get();
      // node:sqlite rows have a null prototype; hand callers an ordinary object.
      return row ? { ...row } : null;
    },
  },
  upsert: {
    run: (args: { $repoUrl: string; $baseBranch: string; $localPath: string }): void => {
      q(
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

/**
 * Ticket dependency edges. `depends_on_ticket_id` must land before `ticket_id` can start.
 *
 * Both columns FK to `tickets` with ON DELETE CASCADE, so deleting a ticket drops its edges
 * without any bookkeeping here.
 */
export const ticketDependencyStmts = {
  /**
   * Idempotent: the PK already rejects duplicates, and re-adding an edge is not an error
   * worth surfacing to a caller who just wants the edge to exist.
   */
  add: {
    run: (ticketId: string, dependsOnTicketId: string): void => {
      q(
        `INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_ticket_id)
         VALUES (?, ?)`,
      ).run(ticketId, dependsOnTicketId);
    },
  },
  /** Everything `ticketId` is waiting on. */
  listBlockers: {
    all: (ticketId: string): string[] =>
      q<{ depends_on_ticket_id: string }>(
        "SELECT depends_on_ticket_id FROM ticket_dependencies WHERE ticket_id = ?",
      )
        .all(ticketId)
        .map((row) => row.depends_on_ticket_id),
  },
  /** Everything waiting on `ticketId` — the question auto-start asks when a ticket lands. */
  listDependents: {
    all: (ticketId: string): string[] =>
      q<{ ticket_id: string }>(
        "SELECT ticket_id FROM ticket_dependencies WHERE depends_on_ticket_id = ?",
      )
        .all(ticketId)
        .map((row) => row.ticket_id),
  },
  /**
   * Every edge on the board, for `ticketsToAutoStart` (common/autoStart.ts) — that function
   * takes the full graph rather than one ticket's blockers, the same shape
   * `countNeedsAttention` takes full tickets/agents arrays, so it stays a pure, testable
   * function instead of a callback threaded through DB queries.
   */
  listAll: {
    all: (): { ticketId: string; dependsOnTicketId: string }[] =>
      q<{ ticket_id: string; depends_on_ticket_id: string }>(
        "SELECT ticket_id, depends_on_ticket_id FROM ticket_dependencies",
      )
        .all()
        .map((row) => ({ dependsOnTicketId: row.depends_on_ticket_id, ticketId: row.ticket_id })),
  },
};

/** An interactive planning session: the conversation that produces tickets. */
export const planningStmts = {
  get: {
    get: (id: string): RawPlanningSession | null =>
      q<RawPlanningSession>(
        `SELECT id, cwd, acp_session_id AS acpSessionId, status, state, plan,
                plan_file_path AS planFilePath, started_at AS startedAt, ended_at AS endedAt
         FROM planning_sessions WHERE id = ?`,
      ).get(id) ?? null,
  },
  insert: {
    run: (args: { $id: string; $cwd: string; $startedAt: number }): void => {
      q(
        `INSERT INTO planning_sessions (id, cwd, status, started_at)
         VALUES ($id, $cwd, 'idle', $startedAt)`,
      ).run(args);
    },
  },
  /** The most recent session, for reattaching the UI after a reload or restart. */
  latest: {
    get: (): RawPlanningSession | null =>
      q<RawPlanningSession>(
        `SELECT id, cwd, acp_session_id AS acpSessionId, status, state, plan,
                plan_file_path AS planFilePath, started_at AS startedAt, ended_at AS endedAt
         FROM planning_sessions ORDER BY started_at DESC LIMIT 1`,
      ).get() ?? null,
  },
  /** The plan itself, captured from ExitPlanMode. */
  savePlan: {
    run: (args: { $id: string; $plan: string; $planFilePath: string | null }): void => {
      q(
        `UPDATE planning_sessions
         SET plan = $plan, plan_file_path = $planFilePath
         WHERE id = $id`,
      ).run(args);
    },
  },
  saveState: {
    run: (args: { $id: string; $state: string; $acpSessionId: string | null }): void => {
      q(
        `UPDATE planning_sessions
         SET state = $state, acp_session_id = $acpSessionId
         WHERE id = $id`,
      ).run(args);
    },
  },
  setStatus: {
    run: (args: { $id: string; $status: string; $endedAt: number | null }): void => {
      q("UPDATE planning_sessions SET status = $status, ended_at = $endedAt WHERE id = $id").run(
        args,
      );
    },
  },
};
