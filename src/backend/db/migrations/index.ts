import type { Migration } from "../migrator.ts";
import m001 from "./001_baseline.ts";
import m002 from "./002_add_agent_title.ts";
import m003 from "./003_add_session_id.ts";

export const migrations: Migration[] = [m001, m002, m003];
