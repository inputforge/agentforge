import type { AcpToolCall } from "./types.ts";

/**
 * Which tool call to show as "what is it doing right now" — the one with the highest
 * `seq`, i.e. the most recently *started*, not necessarily the most recently updated:
 * a completion (`tool_call_update`) doesn't bump `seq`. That is still the right choice:
 * "what did it start doing most recently" is a better one-line answer than "what result
 * last changed", and it matches the ordering AgentAcpPanel's timeline already uses.
 *
 * Pure and framework-free (no React) so it can be unit tested directly, same rationale
 * as `attention.ts`. Used by TicketCard to put the agent's latest activity on the card
 * face — without it a running agent's card says only "RUNNING", forcing anyone
 * supervising several agents to open every detail panel just to see if they're on track.
 */
export function latestToolCall(toolCalls: AcpToolCall[]): AcpToolCall | undefined {
  return toolCalls.reduce<AcpToolCall | undefined>((latest, tc) => {
    if (!latest) {
      return tc;
    }
    return (tc.seq ?? 0) >= (latest.seq ?? 0) ? tc : latest;
  }, undefined);
}
