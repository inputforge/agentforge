import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ShellSessionManager } from "./ShellSessionManager.ts";

/**
 * These tests drive a real pty. They run under Node (vitest, `pool: "forks"`), which is
 * the backend's actual target runtime now that it lives in Electron's main process.
 *
 * Note: node-pty cannot spawn under Bun at all — its `spawn-helper` never reaches
 * `execvp`, so the shell never starts and the pty yields zero bytes forever. That is one
 * of two reasons these tests do not run under `bun test` (the other being that Bun does
 * not implement `node:sqlite`).
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(20);
  }
  return predicate();
}

function randomId(): string {
  return `sess-${randomUUID()}`;
}

interface Sink {
  chunkTypes: Set<string>;
  text: () => string;
}

const manager = new ShellSessionManager();
const spawned = new Set<string>();

function collect(emitter: { on(e: "data", fn: (chunk: unknown) => void): void }): Sink {
  const chunkTypes = new Set<string>();
  let text = "";
  emitter.on("data", (chunk) => {
    chunkTypes.add(typeof chunk);
    text += String(chunk);
  });
  return { chunkTypes, text: () => text };
}

/**
 * Spawns a session and waits for its first output before returning.
 *
 * A write that lands before the shell finishes terminal setup is discarded by its
 * `tcsetattr(TCSAFLUSH)`. Waiting for the prompt means startup is done, which makes
 * the input assertions deterministic rather than racy.
 */
async function spawnReady(
  id: string,
  onExit: (sessionId: string, exitCode: number) => void = () => {},
) {
  const session = manager.spawn(id, process.cwd(), onExit);
  spawned.add(id);
  const sink = collect(session.emitter);
  await waitFor(() => sink.text().length > 0);
  await sleep(50);
  return { session, sink };
}

beforeAll(() => {
  // Pin the shell: spawn() derives it from $SHELL, and a developer's zsh dotfiles
  // may print banners or block on completion init.
  process.env.SHELL = "/bin/sh";
});

afterAll(() => {
  for (const id of spawned) {
    manager.kill(id);
  }
});

describe("ShellSessionManager (real pty)", () => {
  test("spawns a live session, exposes it, and emits output as strings", async () => {
    const { session, sink } = await spawnReady(randomId());

    expect(manager.isRunning(session.id)).toBe(true);
    expect(manager.subscribe(session.id)).toBe(session.emitter);

    // No trailing newline: nothing executes, isolating the echo path from execution.
    manager.write(session.id, "echo terminal-echo-probe");
    expect(
      await waitFor(() => sink.text().includes("terminal-echo-probe")),
      "pty did not echo the typed input back",
    ).toBe(true);
    // node-pty decodes UTF-8 itself; ipc/broadcast.ts depends on receiving strings,
    // never Buffers/Uint8Arrays.
    expect([...sink.chunkTypes]).toStrictEqual(["string"]);

    manager.kill(session.id);
  });

  test("write delivers string input that the shell executes", async () => {
    const { session, sink } = await spawnReady(randomId());

    // The split literal means the echoed command line reads printf 'MARK%s\n' ER,
    // so only real execution can produce "MARKER" — proving execution, not echo.
    manager.write(session.id, "printf 'MARK%s\\n' ER\n");
    expect(await waitFor(() => sink.text().includes("MARKER")), "shell did not execute input").toBe(
      true,
    );

    manager.kill(session.id);
  });

  test("write delivers Buffer input that the shell executes", async () => {
    const { session, sink } = await spawnReady(randomId());

    manager.write(session.id, Buffer.from("printf 'BUF%s\\n' OK\n", "utf8"));
    expect(
      await waitFor(() => sink.text().includes("BUFOK")),
      "shell did not execute Buffer input",
    ).toBe(true);

    manager.kill(session.id);
  });

  test("resize does not throw for a live, unknown, or killed session", async () => {
    const { session } = await spawnReady(randomId());

    expect(() => manager.resize(session.id, 120, 40)).not.toThrow();
    expect(() => manager.resize(randomId(), 120, 40)).not.toThrow();

    manager.kill(session.id);
    expect(() => manager.resize(session.id, 100, 30)).not.toThrow();
  });

  test("kill stops the session and reports the exit code to onExit", async () => {
    const id = randomId();
    let exitedId: string | null = null;
    let exitCode: unknown = "unset";
    const { session } = await spawnReady(id, (sessionId, code) => {
      exitedId = sessionId;
      exitCode = code;
    });

    expect(manager.isRunning(session.id)).toBe(true);
    manager.kill(session.id);
    // isRunning must flip synchronously, before the child is reaped.
    expect(manager.isRunning(session.id)).toBe(false);
    expect(manager.subscribe(session.id)).toBeNull();

    expect(await waitFor(() => exitedId !== null), "onExit never fired").toBe(true);
    expect(exitedId).toBe(id);
    expect(typeof exitCode).toBe("number");
  });

  test("reports the child's own exit code when the shell exits by itself", async () => {
    let exitCode: unknown = "unset";
    let fired = false;
    const { session } = await spawnReady(randomId(), (_id, code) => {
      exitCode = code;
      fired = true;
    });

    manager.write(session.id, "exit 42\n");

    expect(await waitFor(() => fired), "onExit never fired on natural exit").toBe(true);
    expect(exitCode).toBe(42);
    expect(manager.isRunning(session.id)).toBe(false);
  });
});

describe("ShellSessionManager (unknown sessions)", () => {
  test("is inert for unknown session ids", () => {
    const unknown = randomUUID();

    expect(manager.isRunning(unknown)).toBe(false);
    expect(manager.subscribe(unknown)).toBeNull();
    expect(() => manager.write(unknown, "noop")).not.toThrow();
    expect(() => manager.write(unknown, Buffer.from("noop"))).not.toThrow();
    expect(() => manager.resize(unknown, 80, 24)).not.toThrow();
    expect(() => manager.kill(unknown)).not.toThrow();
  });
});
