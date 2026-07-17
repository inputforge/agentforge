/**
 * Main-process logger.
 *
 * A packaged GUI app has no attached terminal, so `console.log` goes nowhere the
 * user can find. Everything is mirrored to `<userData>/logs/main.log` so crash
 * reports are recoverable after the fact.
 *
 * The file sink is initialised lazily: `app.getPath("userData")` is only correct
 * after `app.setName()` has run, and callers may log before that.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_LABEL: Record<Level, string> = {
  debug: "DEBUG",
  error: "ERROR",
  info: "INFO ",
  warn: "WARN ",
};

let logFile: string | null = null;
let fileSinkFailed = false;

/** Resolve the log file path once. Returns null until userData is usable. */
function resolveLogFile(): string | null {
  if (logFile !== null || fileSinkFailed) {
    return logFile;
  }
  try {
    const dir = join(app.getPath("userData"), "logs");
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, "main.log");
    return logFile;
  } catch {
    // userData not resolvable yet (or not writable) — console only.
    return null;
  }
}

function format(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const message = args.map(format).join(" ");
  const line = `${new Date().toISOString()} ${LEVEL_LABEL[level]} [${scope}] ${message}`;

  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);

  const file = resolveLogFile();
  if (file === null) {
    return;
  }
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Never let logging take the app down; stop retrying the file sink.
    fileSinkFailed = true;
  }
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Create a scoped logger. Scope is a short module tag, e.g. "main", "pty". */
export function createLogger(scope: string): Logger {
  return {
    debug: (...args) => emit("debug", scope, args),
    error: (...args) => emit("error", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
  };
}

/** Where the log file lives, for surfacing in error dialogs. Null before ready. */
export function logFilePath(): string | null {
  return resolveLogFile();
}
