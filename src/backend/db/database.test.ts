/**
 * Tests for the node:sqlite database layer.
 *
 * These run on vitest under Node because the database layer runs in Electron's main
 * process (Node 24.18):
 *
 *   vitest run src/backend/db/
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  agentStmts,
  closeDb,
  diffCommentStmts,
  initDb,
  integrationStmts,
  remoteStmts,
  ticketStmts,
} from "./database.ts";
import { migrations } from "./migrations/index.ts";
import {
  type DatabaseAdapter,
  type Migration,
  MigrationRunner,
  SqliteAdapter,
} from "./migrator.ts";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentforge-db-"));
  tempDirs.push(dir);
  return dir;
}

function dbFile(repoPath: string): string {
  return join(repoPath, ".agentforge/data/agentforge.db");
}

/**
 * node:sqlite hands back rows with a null prototype, and toStrictEqual compares
 * prototypes — copy rows before comparing them to object literals.
 */
function plain<T extends object>(rows: T[]): T[] {
  return rows.map((row) => Object.assign({}, row));
}

/** Read the DB over a second connection, so tests never depend on internals. */
function inspect<T>(repoPath: string, fn: (db: DatabaseSync) => T): T {
  const raw = new DatabaseSync(dbFile(repoPath));
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

function seedTicket(
  id = "t1",
  overrides: Partial<{ $createdAt: number; $status: string; $title: string }> = {},
): void {
  ticketStmts.insert.run({
    $baseBranch: "main",
    $createdAt: 1000,
    $description: "desc",
    $id: id,
    $status: "backlog",
    $title: "title",
    $updatedAt: 1000,
    ...overrides,
  });
}

function seedAgent(id = "a1", ticketId = "t1"): void {
  agentStmts.insert.run({
    $baseBranch: "main",
    $branch: `agent/${ticketId}`,
    $command: "claude",
    $id: id,
    $startedAt: 2000,
    $status: "running",
    $ticketId: ticketId,
    $type: "claude-code",
    $worktreePath: `/tmp/wt/${ticketId}`,
  });
}

describe("initDb", () => {
  afterEach(() => {
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("has no filesystem side effects at import time", () => {
    // The packaged Electron app is launched from the Finder with cwd "/", so an
    // import-time mkdir would target "/.agentforge" and fail before any code can
    // intervene. Import the module in a child process and assert it touches nothing.
    const probe = makeRepo();
    const modulePath = fileURLToPath(new URL("./database.ts", import.meta.url));

    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(modulePath)});`],
      { cwd: probe, env: { ...process.env, REPO_PATH: probe }, stdio: "pipe" },
    );

    expect(existsSync(join(probe, ".agentforge"))).toBe(false);
  });

  test("creates the database, applies pragmas and migrations", () => {
    const repo = makeRepo();
    initDb(repo);

    expect(existsSync(dbFile(repo))).toBe(true);

    const journalMode = inspect(repo, (db) => db.prepare("PRAGMA journal_mode").get()) as {
      journal_mode: string;
    };
    expect(journalMode.journal_mode).toBe("wal");

    expect(
      plain(
        inspect(repo, (db) => db.prepare("SELECT name FROM _migrations ORDER BY name").all()) as {
          name: string;
        }[],
      ),
    ).toStrictEqual(migrations.map((m) => ({ name: m.name })));
  });

  test("applies every migration once and is a no-op on the second run", () => {
    const repo = makeRepo();
    initDb(repo);

    const readApplied = (): { applied_at: number; name: string }[] =>
      plain(
        inspect(repo, (db) =>
          db.prepare("SELECT name, applied_at FROM _migrations ORDER BY name").all(),
        ) as { applied_at: number; name: string }[],
      );

    const first = readApplied();
    // Derived, not hardcoded: a literal count here fails on every migration added, which
    // says nothing about whether the migrator works.
    expect(first.length).toBe(migrations.length);

    closeDb();
    // A re-applied migration would hit the _migrations PRIMARY KEY and throw.
    initDb(repo);

    // Same rows, same applied_at: nothing re-ran.
    expect(readApplied()).toStrictEqual(first);
  });

  test("rejects a second open and rejects statements once closed", () => {
    const repo = makeRepo();
    initDb(repo);
    expect(() => initDb(repo)).toThrow(/already open/);

    closeDb();
    expect(() => ticketStmts.list.all()).toThrow(/not open/);
  });

  test("drops cached statements when the database is swapped", () => {
    // The statement cache is keyed by SQL text only; if it survived a reopen it
    // would hand back statements bound to the closed database.
    const first = makeRepo();
    initDb(first);
    seedTicket("t1");
    expect(ticketStmts.list.all().length).toBe(1);

    closeDb();
    const second = makeRepo();
    initDb(second);

    expect(ticketStmts.list.all()).toStrictEqual([]);
    seedTicket("t2");
    expect(ticketStmts.get.get("t2")?.id).toBe("t2");
    expect(ticketStmts.get.get("t1")).toBe(null);
  });
});

describe("statements", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
    initDb(repo);
  });

  afterEach(() => {
    closeDb();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("round-trips a ticket through $-prefixed named parameters", () => {
    seedTicket("t1", { $title: "Fix login" });

    // Proves node:sqlite binds "$foo" keys verbatim.
    expect(ticketStmts.get.get("t1")).toStrictEqual({
      agentId: null,
      archivedAt: null,
      baseBranch: "main",
      branch: null,
      createdAt: 1000,
      description: "desc",
      id: "t1",
      status: "backlog",
      title: "Fix login",
      updatedAt: 1000,
      worktree: null,
    });
    expect(ticketStmts.get.get("missing")).toBe(null);
  });

  test("updates, links and deletes tickets", () => {
    seedTicket("t1");

    ticketStmts.updateTitle.run({ $id: "t1", $title: "renamed", $updatedAt: 1100 });
    ticketStmts.updateStatus.run({ $id: "t1", $status: "in-progress", $updatedAt: 1200 });
    ticketStmts.updateBaseBranch.run({ $baseBranch: "develop", $id: "t1", $updatedAt: 1400 });
    ticketStmts.linkAgent.run({
      $agentId: "a1",
      $branch: "agent/t1",
      $ticketId: "t1",
      $updatedAt: 1500,
      $worktree: "/tmp/wt/t1",
    });

    const ticket = ticketStmts.get.get("t1");
    expect(ticket?.title).toBe("renamed");
    expect(ticket?.status).toBe("in-progress");
    expect(ticket?.baseBranch).toBe("develop");
    expect(ticket?.agentId).toBe("a1");
    expect(ticket?.branch).toBe("agent/t1");
    expect(ticket?.worktree).toBe("/tmp/wt/t1");
    expect(ticket?.updatedAt).toBe(1500);

    ticketStmts.delete.run("t1");
    expect(ticketStmts.get.get("t1")).toBe(null);
  });

  test("lists tickets newest first, excluding archived ones", () => {
    seedTicket("old", { $createdAt: 1 });
    ticketStmts.insert.run({
      $baseBranch: null,
      $createdAt: 5000,
      $description: "",
      $id: "new",
      $status: "backlog",
      $title: "newer",
      $updatedAt: 5000,
    });

    expect(ticketStmts.list.all().map((t) => t.id)).toStrictEqual(["new", "old"]);

    ticketStmts.archive.run({ $archivedAt: 6000, $id: "new" });
    expect(ticketStmts.list.all().map((t) => t.id)).toStrictEqual(["old"]);
    expect(ticketStmts.listArchived.all().map((t) => t.id)).toStrictEqual(["new"]);
  });

  test("archive is idempotent: second archive reports 0 changes", () => {
    seedTicket("t1");

    const first = ticketStmts.archive.run({ $archivedAt: 7000, $id: "t1" });
    expect(first.changes).toBe(1);
    // The cast in q() claims plain numbers — no bigint leaks through.
    expect(typeof first.changes).toBe("number");

    const second = ticketStmts.archive.run({ $archivedAt: 8000, $id: "t1" });
    expect(second.changes).toBe(0);

    // The no-op must not have moved archived_at.
    expect(ticketStmts.listArchived.all()[0]?.archivedAt).toBe(7000);
    expect(ticketStmts.archive.run({ $archivedAt: 9000, $id: "missing" }).changes).toBe(0);
  });

  test("unarchive is idempotent: second unarchive reports 0 changes", () => {
    seedTicket("t1");
    ticketStmts.archive.run({ $archivedAt: 7000, $id: "t1" });

    const first = ticketStmts.unarchive.run({ $id: "t1", $updatedAt: 8000 });
    expect(first.changes).toBe(1);

    const second = ticketStmts.unarchive.run({ $id: "t1", $updatedAt: 9000 });
    expect(second.changes).toBe(0);

    expect(ticketStmts.get.get("t1")?.archivedAt).toBe(null);
    expect(ticketStmts.get.get("t1")?.updatedAt).toBe(8000);
    expect(ticketStmts.unarchive.run({ $id: "missing", $updatedAt: 9000 }).changes).toBe(0);
  });

  test("round-trips an agent", () => {
    seedTicket("t1");
    seedAgent("a1", "t1");

    expect(agentStmts.get.get("a1")).toStrictEqual({
      baseBranch: "main",
      branch: "agent/t1",
      command: "claude",
      endedAt: null,
      id: "a1",
      pid: null,
      sessionId: null,
      startedAt: 2000,
      status: "running",
      ticketId: "t1",
      type: "claude-code",
      worktreePath: "/tmp/wt/t1",
    });
    expect(agentStmts.get.get("nope")).toBe(null);
    expect(agentStmts.listRunning.all().map((a) => a.id)).toStrictEqual(["a1"]);
    expect(agentStmts.listByTicket.all("t1").map((a) => a.id)).toStrictEqual(["a1"]);
  });

  test("updates agent pid, base branch, status and session id", () => {
    seedTicket("t1");
    seedAgent("a1", "t1");

    agentStmts.updatePid.run({ $id: "a1", $pid: 4242 });
    agentStmts.updateBaseBranch.run({ $baseBranch: "release", $id: "a1" });
    agentStmts.updateSessionId.run({ $id: "a1", $sessionId: "sess-1" });
    // updateSessionId only fills a NULL session_id.
    agentStmts.updateSessionId.run({ $id: "a1", $sessionId: "sess-2" });

    let agent = agentStmts.get.get("a1");
    expect(agent?.pid).toBe(4242);
    expect(agent?.baseBranch).toBe("release");
    expect(agent?.sessionId).toBe("sess-1");

    agentStmts.overwriteSessionId.run({ $id: "a1", $sessionId: "sess-3" });
    agentStmts.updateStatus.run({ $endedAt: 3000, $id: "a1", $status: "exited" });

    agent = agentStmts.get.get("a1");
    expect(agent?.sessionId).toBe("sess-3");
    expect(agent?.status).toBe("exited");
    expect(agent?.endedAt).toBe(3000);
    expect(agentStmts.listRunning.all()).toStrictEqual([]);

    // Null binding through a named parameter.
    agentStmts.updateStatus.run({ $endedAt: null, $id: "a1", $status: "running" });
    expect(agentStmts.get.get("a1")?.endedAt).toBe(null);
  });

  test("saves and loads opaque agent state", () => {
    seedTicket("t1");
    seedAgent("a1", "t1");

    expect(agentStmts.loadAgentState.get("a1")).toBe(null);
    agentStmts.saveAgentState.run({ $agentState: '{"turns":3}', $id: "a1" });
    expect(agentStmts.loadAgentState.get("a1")).toBe('{"turns":3}');
    expect(agentStmts.loadAgentState.get("missing")).toBe(null);
  });

  test("round-trips remote config and upserts over the existing row", () => {
    expect(remoteStmts.get.get()).toBe(null);

    remoteStmts.upsert.run({
      $baseBranch: "main",
      $localPath: "/repos/one",
      $repoUrl: "git@github.com:acme/one.git",
    });
    expect(remoteStmts.get.get()).toStrictEqual({
      baseBranch: "main",
      localPath: "/repos/one",
      repoUrl: "git@github.com:acme/one.git",
    });

    remoteStmts.upsert.run({
      $baseBranch: "develop",
      $localPath: "/repos/two",
      $repoUrl: "git@github.com:acme/two.git",
    });
    expect(remoteStmts.get.get()).toStrictEqual({
      baseBranch: "develop",
      localPath: "/repos/two",
      repoUrl: "git@github.com:acme/two.git",
    });
    const rowCount = inspect(
      repo,
      (db) => db.prepare("SELECT COUNT(*) AS n FROM remote_config").get() as { n: number },
    );
    expect(rowCount.n).toBe(1);

    // Rows must reach callers as ordinary objects, not [Object: null prototype].
    expect(Object.getPrototypeOf(remoteStmts.get.get())).toBe(Object.prototype);
  });

  test("round-trips integration config through positional parameters", () => {
    expect(integrationStmts.get("github", "token")).toBe(null);
    expect(integrationStmts.getAll("github")).toStrictEqual({});

    integrationStmts.set("github", "token", "ghp_1");
    integrationStmts.set("github", "owner", "acme");
    integrationStmts.set("linear", "token", "lin_1");

    expect(integrationStmts.get("github", "token")).toBe("ghp_1");
    expect(integrationStmts.getAll("github")).toStrictEqual({ owner: "acme", token: "ghp_1" });

    integrationStmts.set("github", "token", "ghp_2");
    expect(integrationStmts.get("github", "token")).toBe("ghp_2");

    integrationStmts.deleteAll("github");
    expect(integrationStmts.getAll("github")).toStrictEqual({});
    expect(integrationStmts.getAll("linear")).toStrictEqual({ token: "lin_1" });
  });

  test("round-trips diff comments", () => {
    seedTicket("t1");
    seedAgent("a1", "t1");

    diffCommentStmts.insert.run({
      $agentId: "a1",
      $content: "nit: rename",
      $createdAt: 4000,
      $endLine: 12,
      $filePath: "src/index.ts",
      $id: "c1",
      $side: "additions",
      $startLine: 10,
    });

    const comments = diffCommentStmts.listByAgent.all("a1");
    expect(comments).toStrictEqual([
      {
        agentId: "a1",
        content: "nit: rename",
        createdAt: 4000,
        endLine: 12,
        filePath: "src/index.ts",
        id: "c1",
        side: "additions",
        startLine: 10,
      },
    ]);
    expect(Object.getPrototypeOf(comments[0])).toBe(Object.prototype);

    diffCommentStmts.delete.run("c1", "other-agent");
    expect(diffCommentStmts.listByAgent.all("a1").length, "delete is scoped to its agent").toBe(1);

    diffCommentStmts.delete.run("c1", "a1");
    expect(diffCommentStmts.listByAgent.all("a1")).toStrictEqual([]);

    diffCommentStmts.insert.run({
      $agentId: "a1",
      $content: "another",
      $createdAt: 5000,
      $endLine: 2,
      $filePath: "src/other.ts",
      $id: "c2",
      $side: "deletions",
      $startLine: 1,
    });
    diffCommentStmts.deleteByAgent.run("a1");
    expect(diffCommentStmts.listByAgent.all("a1")).toStrictEqual([]);
  });

  test("enforces foreign keys", () => {
    expect(() =>
      diffCommentStmts.insert.run({
        $agentId: "ghost",
        $content: "x",
        $createdAt: 1,
        $endLine: 1,
        $filePath: "f",
        $id: "c1",
        $side: "additions",
        $startLine: 1,
      }),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe("SqliteAdapter.transaction", () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    adapter = new SqliteAdapter(db);
  });

  afterEach(() => {
    db.close();
  });

  function tableExists(name: string): boolean {
    return (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    );
  }

  test("commits work done inside the callback", () => {
    adapter.transaction(() => {
      adapter.run("CREATE TABLE t (id TEXT)");
      adapter.run("INSERT INTO t (id) VALUES (?)", "x");
    });

    expect(db.isTransaction).toBe(false);
    expect(adapter.query<{ id: string }>("SELECT id FROM t").map((row) => row.id)).toStrictEqual([
      "x",
    ]);
  });

  test("query returns node:sqlite's null-prototype rows unchanged", () => {
    adapter.run("CREATE TABLE t (id TEXT)");
    adapter.run("INSERT INTO t (id) VALUES (?)", "x");

    // Documented, not accidental: MigrationRunner only reads properties off these
    // rows, which works on a null prototype. Anything reaching for hasOwnProperty
    // or a prototype method must copy the row first.
    const [row] = adapter.query<{ id: string }>("SELECT id FROM t");
    expect(Object.getPrototypeOf(row)).toBe(null);
    expect(row?.id).toBe("x");
  });

  test("rolls back everything and rethrows when the callback throws", () => {
    adapter.run("CREATE TABLE keep (id TEXT)");
    adapter.run("INSERT INTO keep (id) VALUES (?)", "before");

    const boom = new Error("boom");
    // The original assertion was `assert.throws(fn, (error) => error === boom)`: the
    // rethrow must be the very same Error object, not a lookalike. `toThrow(boom)`
    // would only compare messages, so capture the throw and compare identity.
    let thrown: unknown;
    try {
      adapter.transaction(() => {
        adapter.run("INSERT INTO keep (id) VALUES (?)", "during");
        adapter.run("CREATE TABLE gone (id TEXT)");
        throw boom;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);

    expect(db.isTransaction, "no transaction may be left open").toBe(false);
    expect(tableExists("gone"), "DDL must roll back").toBe(false);
    expect(
      adapter.query<{ id: string }>("SELECT id FROM keep").map((row) => row.id),
      "the INSERT inside the transaction must roll back too",
    ).toStrictEqual(["before"]);
  });

  test("joins an enclosing transaction instead of nesting BEGIN", () => {
    adapter.transaction(() => {
      adapter.run("CREATE TABLE outer_t (id TEXT)");
      adapter.transaction(() => {
        adapter.run("CREATE TABLE inner_t (id TEXT)");
      });
    });

    expect(tableExists("outer_t")).toBe(true);
    expect(tableExists("inner_t")).toBe(true);
  });

  test("an outer rollback discards a nested transaction's work", () => {
    expect(() => {
      adapter.transaction(() => {
        adapter.transaction(() => {
          adapter.run("CREATE TABLE inner_t (id TEXT)");
        });
        throw new Error("outer failed");
      });
    }).toThrow(/outer failed/);

    expect(db.isTransaction).toBe(false);
    expect(tableExists("inner_t")).toBe(false);
  });
});

describe("MigrationRunner", () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    adapter = new SqliteAdapter(db);
  });

  afterEach(() => {
    db.close();
  });

  const good: Migration = {
    name: "001_good",
    up(migrationDb) {
      migrationDb.run("CREATE TABLE good (id TEXT)");
    },
  };

  const bad: Migration = {
    name: "002_bad",
    up(migrationDb) {
      migrationDb.run("CREATE TABLE half_done (id TEXT)");
      throw new Error("migration exploded");
    },
  };

  function appliedNames(): string[] {
    return adapter
      .query<{ name: string }>("SELECT name FROM _migrations ORDER BY name")
      .map((row) => row.name);
  }

  test("applies pending migrations and skips applied ones", () => {
    new MigrationRunner(adapter).run([good]);
    expect(appliedNames()).toStrictEqual(["001_good"]);

    let secondRun = 0;
    new MigrationRunner(adapter).run([
      good,
      {
        name: "002_more",
        up(migrationDb) {
          secondRun += 1;
          migrationDb.run("CREATE TABLE more (id TEXT)");
        },
      },
    ]);

    expect(secondRun, "only the pending migration runs").toBe(1);
    expect(appliedNames()).toStrictEqual(["001_good", "002_more"]);
  });

  test("a throwing migration leaves the DB unchanged and is not recorded", () => {
    expect(() => new MigrationRunner(adapter).run([good, bad])).toThrow(/migration exploded/);

    expect(db.isTransaction).toBe(false);
    // The earlier migration committed in its own transaction and stands.
    expect(appliedNames()).toStrictEqual(["001_good"]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get(),
      "the failed migration's DDL must be rolled back",
    ).toBe(undefined);

    // The failure is not sticky: the DB is usable and the migration can be retried.
    new MigrationRunner(adapter).run([
      good,
      {
        name: "002_bad",
        up(migrationDb) {
          migrationDb.run("CREATE TABLE half_done (id TEXT)");
        },
      },
    ]);
    expect(appliedNames()).toStrictEqual(["001_good", "002_bad"]);
  });
});
