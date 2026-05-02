import type { EventEmitter } from "events";

export interface IAgentManager {
  spawn(
    agentId: string,
    input: string,
    worktreePath: string,
    onExit: (agentId: string, code: number) => void,
  ): void;
  write(agentId: string, input: string): void;
  kill(agentId: string): void;
  killAndWait(agentId: string): Promise<void>;
  subscribe(agentId: string): EventEmitter | null;
  isRunning(agentId: string): boolean;
}
