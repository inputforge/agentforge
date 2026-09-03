import type { AgentForgeBridge } from "../../common/ipc";

/**
 * The preload `contextBridge` exposes the IPC bridge on `window` under
 * `BRIDGE_KEY` from `src/common/ipc.ts`. The key must be written literally here
 * because a `declare global` property name cannot be a `const` reference.
 * If `BRIDGE_KEY` ever changes, this declaration must change with it.
 */
declare global {
  interface Window {
    agentforge: AgentForgeBridge;
  }
}
