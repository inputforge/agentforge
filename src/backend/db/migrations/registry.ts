import type { Migration } from "../migrator.ts";
import m001 from "./001_baseline.ts";
import m002 from "./002_add_agent_title.ts";
import m003 from "./003_add_session_id.ts";
import m004 from "./004_add_agent_base_branch.ts";
import m005 from "./005_add_integrations.ts";
import m006 from "./006_add_ticket_base_branch.ts";
import m007 from "./007_add_claude_state.ts";
import m008 from "./008_add_acp_state.ts";
import m009 from "./009_add_agent_state.ts";
import m010 from "./010_add_diff_comments.ts";
import m011 from "./011_add_archive.ts";
import m012 from "./012_add_ticket_dependencies.ts";
import m013 from "./013_add_planning_sessions.ts";
export const migrations: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
];
