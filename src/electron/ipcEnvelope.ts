/**
 * Wire format for `IPC_INVOKE` replies — a private main↔preload detail.
 *
 * ── Why an envelope instead of letting handlers throw ───────────────────────────
 * Electron mangles anything thrown across `ipcRenderer.invoke`. A backend
 * `new Error("ticket not found")` arrives at the renderer as:
 *
 *   Error invoking remote method 'af:invoke': Error: ticket not found
 *
 * The renderer renders `(error as Error).message` raw at ~20 sites
 * (src/frontend/store/store.ts:142,163,178,203,241,287 and WorktreeShellPanel), so
 * that prefix goes straight on screen.
 *
 * So nothing is ever thrown across the boundary: main catches and *returns* a
 * result envelope, preload unwraps it and re-throws a clean Error whose `.message`
 * is byte-identical to what the backend threw. Regex-stripping the prefix in
 * preload would be brittle string-munging against an Electron-internal format that
 * carries no stability guarantee.
 *
 * This type is intentionally NOT in src/common/ipc.ts: the envelope must not leak
 * into the contract. `AgentForgeBridge.invoke` stays `Promise<IpcResult<M>>` and
 * `IpcHandlers` keeps throwing normally — both sides of the public contract are
 * unaware this exists.
 *
 * ── Why there is no `name` field ────────────────────────────────────────────────
 * `error.name` cannot survive the trip, so carrying it would be a lie. It travels
 * over the IPC channel fine, but the preload throws into the *renderer's* isolated
 * world through contextBridge, which reconstructs Errors and keeps ONLY `.message`.
 * Measured on Electron 43.1.1 — preload throws `name="ConflictError"`,
 * `customProp="hello"`; the renderer catches:
 *
 *     { name: "Error", message: "named failure", custom: undefined }
 *
 * So the message is the entire usable error channel. That is sufficient: the
 * frontend renders `(error as Error).message` and nothing reads `.name`.
 */

/** A handler's outcome, always *returned*, never thrown. */
export type IpcReply = { ok: true; value: unknown } | { ok: false; error: string };

/** Build a failure envelope from an unknown thrown value. */
export function failure(error: unknown): IpcReply {
  return { error: error instanceof Error ? error.message : String(error), ok: false };
}

/**
 * Narrow an untrusted reply. Main is trusted, but the value crosses a structured
 * clone boundary and a malformed reply must surface as an error, not `undefined`.
 */
export function isIpcReply(value: unknown): value is IpcReply {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }
  const reply = value as { ok: unknown; error?: unknown };
  return reply.ok === true || (reply.ok === false && typeof reply.error === "string");
}
