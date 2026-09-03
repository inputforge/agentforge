/**
 * Schema tests for the dependency and planning-session tables.
 *
 * These assert the *constraints*, not just that the DDL ran: a FK or CHECK that silently is
 * not enforced looks identical to one that is until bad data lands. `PRAGMA foreign_keys` is
 * per-connection, so it is set explicitly here — the app sets it in database.ts, and a test
 * that forgot it would pass while proving nothing.
 *
 * `toEqual`, not `toStrictEqual`: node:sqlite rows have a null prototype, which toStrictEqual
 * rejects while printing two identical-looking objects. database.test.ts solves the same
 * problem with its `plain()` helper (copy the row, then compare strictly); toEqual is the
 * same fix without a helper, since these assertions are small.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, initDb } from "../database.ts";

const dirs: string[] = [];
let repo: string;
let db: DatabaseSync;

function seed(id: string): void {
  db.prepare(
    "INSERT INTO tickets (id,title,description,status,created_at,updated_at) VALUES (?,?,?,?,1,1)",
  ).run(id, id, "d", "backlog");
}

describe("012 ticket_dependencies", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "af-mig-"));
    dirs.push(repo);
    initDb(repo);
    db = new DatabaseSync(join(repo, ".agentforge/data/agentforge.db"));
    db.exec("PRAGMA foreign_keys = ON;");
  });

  afterEach(() => {
    db.close();
    closeDb();
    for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true });
  });

  it("stores an edge", () => {
    seed("a");
    seed("b");
    db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("b", "a");
    expect(
      db.prepare("SELECT ticket_id FROM ticket_dependencies WHERE depends_on_ticket_id='a'").all(),
    ).toEqual([{ ticket_id: "b" }]);
  });

  it("rejects a self-dependency via CHECK", () => {
    seed("a");
    expect(() =>
      db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("a", "a"),
    ).toThrow();
  });

  it("rejects an edge to a nonexistent ticket via FK", () => {
    seed("a");
    expect(() =>
      db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("a", "ghost"),
    ).toThrow();
  });

  it("cascades away edges when the blocker is deleted", () => {
    seed("a");
    seed("b");
    db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("b", "a");
    db.prepare("DELETE FROM tickets WHERE id='a'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM ticket_dependencies").get()).toEqual({ c: 0 });
  });

  it("cascades away edges when the dependent is deleted", () => {
    seed("a");
    seed("b");
    db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("b", "a");
    db.prepare("DELETE FROM tickets WHERE id='b'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM ticket_dependencies").get()).toEqual({ c: 0 });
  });

  it("rejects a duplicate edge via the PK", () => {
    seed("a");
    seed("b");
    db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("b", "a");
    expect(() =>
      db.prepare("INSERT INTO ticket_dependencies VALUES (?,?)").run("b", "a"),
    ).toThrow();
  });
});

describe("013 planning_sessions", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "af-mig2-"));
    dirs.push(repo);
    initDb(repo);
    db = new DatabaseSync(join(repo, ".agentforge/data/agentforge.db"));
  });

  afterEach(() => {
    db.close();
    closeDb();
    for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true });
  });

  it("exists with no ticket or agent required", () => {
    db.prepare("INSERT INTO planning_sessions (id,cwd,started_at) VALUES (?,?,?)").run(
      "p1",
      "/repo",
      1,
    );
    expect(db.prepare("SELECT id,status FROM planning_sessions").get()).toEqual({
      id: "p1",
      status: "idle",
    });
  });
});
