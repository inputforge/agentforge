import type { Context, MiddlewareHandler, Next } from "hono";
import { randomUUID } from "crypto";

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
type LogFormat = "pretty" | "json";
type LogMeta = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

const configuredLevel = normalizeLevel(process.env.LOG_LEVEL);
const configuredFormat = normalizeFormat(process.env.LOG_FORMAT);
const loggedErrors = new WeakSet<object>();

function normalizeLevel(level: string | undefined): LogLevel {
  switch (level?.toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return level.toLowerCase() as LogLevel;
    default:
      return process.env.NODE_ENV === "test" ? "silent" : "info";
  }
}

function normalizeFormat(format: string | undefined): LogFormat {
  return format?.toLowerCase() === "json" ? "json" : "pretty";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel];
}

function serializeError(error: unknown): LogMeta {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { error };
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function sanitizeMeta(meta: LogMeta | undefined): LogMeta | undefined {
  if (!meta) return undefined;

  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, serializeValue(value)]),
  );
}

function write(level: Exclude<LogLevel, "silent">, scope: string, message: string, meta?: LogMeta) {
  if (!shouldLog(level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...sanitizeMeta(meta),
  };

  const line =
    configuredFormat === "json"
      ? JSON.stringify(entry)
      : `[${entry.ts}] ${level.toUpperCase()} ${scope}: ${message}${
          meta ? ` ${JSON.stringify(sanitizeMeta(meta))}` : ""
        }`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export class Logger {
  constructor(private readonly scope: string) {}

  debug(message: string, meta?: LogMeta): void {
    write("debug", this.scope, message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    write("info", this.scope, message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    write("warn", this.scope, message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    write("error", this.scope, message, meta);
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`);
  }
}

export const logger = new Logger("agentforge");

function getRequestId(c: Context): string {
  return c.req.header("x-request-id") ?? randomUUID();
}

function getRequestPath(c: Context): string {
  return new URL(c.req.url).pathname;
}

export function requestLogger(): MiddlewareHandler {
  const httpLogger = logger.child("http");

  return async (c: Context, next: Next) => {
    const start = performance.now();
    const requestId = getRequestId(c);
    c.header("x-request-id", requestId);

    try {
      await next();
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      httpLogger.error("request failed", {
        requestId,
        method: c.req.method,
        path: getRequestPath(c),
        durationMs,
        ...serializeError(error),
      });
      markErrorLogged(error);
      throw error;
    }

    const durationMs = Math.round(performance.now() - start);
    const status = c.res.status;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

    httpLogger[level]("request completed", {
      requestId,
      method: c.req.method,
      path: getRequestPath(c),
      status,
      durationMs,
    });
  };
}

export function errorMeta(error: unknown): LogMeta {
  return serializeError(error);
}

export function markErrorLogged(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    loggedErrors.add(error);
  }
}

export function wasErrorLogged(error: unknown): boolean {
  return typeof error === "object" && error !== null && loggedErrors.has(error);
}
