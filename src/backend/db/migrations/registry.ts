import type { Migration } from "../migrator.ts";
import m001 from "./001_baseline.ts";
import m002 from "./002_add_agent_title.ts";
import m003 from "./003_add_session_id.ts";
import m004 from "./004_add_agent_base_branch.ts";
import m005 from "./005_add_integrations.ts";
import m006 from "./006_add_agent_output.ts";

export const migrations: Migration[] = [m001, m002, m003, m004, m005, m006];
