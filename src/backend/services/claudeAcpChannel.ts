/**
 * Wiring and small parsing helpers for an in-process Claude Code ACP connection.
 *
 * Extracted so both consumers share it rather than duplicating the subtleties below:
 *   - AcpClientManager — execution agents, one per ticket, in a git worktree.
 *   - PlanningService  — a read-only planning session in the repo root, producing tickets.
 *
 * The two differ in almost everything that matters (worktree vs repo root, editing vs plan
 * mode, exit-to-review vs exit-to-tickets, and crucially how they answer permission
 * requests), so they own separate `Client` implementations. This module is the transport
 * and response-parsing logic they have in common.
 */

import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import { isExecutableFile, whichSync } from "../lib/which.ts";

export const CLAUDE_NOT_INSTALLED_ERROR =
  "claude was not found. Set CLAUDE_CODE_EXECUTABLE to the claude binary, or install " +
  "Claude Code so that it is on your PATH.";

/**
 * Resolution order: `CLAUDE_CODE_EXECUTABLE` (an explicit override) → PATH lookup →
 * null. Mirrors `CodexService.resolveBinaryPath()`; neither binary ships with the app.
 */
export function resolveClaudePath(): string | null {
  const configured = process.env.CLAUDE_CODE_EXECUTABLE;
  if (configured) {
    return isExecutableFile(configured) ? configured : null;
  }
  return whichSync("claude");
}

/**
 * Wires ClaudeAcpAgent in-process via a paired TransformStream, avoiding any
 * subprocess. Returns the client-facing Stream and the AgentSideConnection
 * reference (must be kept alive to prevent GC of its stream listeners).
 */
export function buildClaudeInProcessChannel(): {
  stream: Stream;
  agentSideConn: AgentSideConnection;
} {
  // ClaudeAcpAgent's ctor takes no options, so the executable can only be injected
  // through the environment: acp-agent.js's claudeCliPath() reads
  // CLAUDE_CODE_EXECUTABLE and, only if unset, falls back to resolving its own
  // per-arch optional dep out of node_modules. We do not ship that dep — the user
  // installs Claude Code — so resolve from PATH and set the var before it runs.
  const claudePath = resolveClaudePath();
  if (!claudePath) {
    throw new Error(CLAUDE_NOT_INSTALLED_ERROR);
  }
  process.env.CLAUDE_CODE_EXECUTABLE = claudePath;

  const clientToAgent = new TransformStream<AnyMessage, AnyMessage>();
  const agentToClient = new TransformStream<AnyMessage, AnyMessage>();

  const clientStream: Stream = {
    readable: agentToClient.readable,
    writable: clientToAgent.writable,
  };
  const agentStream: Stream = {
    readable: clientToAgent.readable,
    writable: agentToClient.writable,
  };

  const agentSideConn = new AgentSideConnection((conn) => new ClaudeAcpAgent(conn), agentStream);

  return { agentSideConn, stream: clientStream };
}

/**
 * Pull the first text block out of a `tool_call_update`'s content — what a tool actually
 * returned, truncated to 300 chars. Both AcpClientManager and PlanningService receive the
 * identical ACP shape here; this was previously defined only in AcpClientManager, so
 * PlanningService's own tool calls never got a resultSummary at all.
 */
export function extractResultSummary(update: {
  content?: { type: string; content?: { type: string; text?: string } }[] | null;
}): string | null {
  if (!update.content) {
    return null;
  }
  for (const item of update.content) {
    if (item.type === "content" && item.content?.type === "text" && item.content.text) {
      return item.content.text.slice(0, 300);
    }
  }
  return null;
}
