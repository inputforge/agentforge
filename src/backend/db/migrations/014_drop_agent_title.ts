import type { Migration } from "../migrator.ts";

/**
 * Drops `tickets.agent_title` — added in 002, never once written by any code path.
 * `ticketStmts.updateAgentTitle` existed only in its own DB test; nothing in
 * OrchestratorService, the IPC handlers, or anywhere else ever called it. The column
 * was always NULL, so there is no data to migrate — this is the same "no stubs" call
 * already made for AcpAgentState.plan (see the commit removing PlanPanel): a UI branch
 * that can never fire is dead code, not a feature waiting to be finished.
 */
export default {
  name: "014_drop_agent_title",
  up(db) {
    const cols = db.query<{ name: string }>("SELECT name FROM pragma_table_info('tickets')");
    if (cols.some((c) => c.name === "agent_title")) {
      db.run("ALTER TABLE tickets DROP COLUMN agent_title");
    }
  },
} satisfies Migration;
