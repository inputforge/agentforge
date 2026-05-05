import { existsSync } from "node:fs";
import { join } from "path";
import type { CodexStatus } from "../../common/types.ts";

const projectRoot = join(import.meta.dir, "../../..");

export class CodexService {
  resolveBinaryPath(): string {
    const local = join(projectRoot, "node_modules/.bin/codex-acp");
    if (existsSync(local)) return local;
    return "codex-acp";
  }

  async getStatus(): Promise<CodexStatus> {
    const command = this.resolveBinaryPath();
    const installed = existsSync(command) || command === "codex-acp";

    return {
      installed,
      authenticated: installed,
      ready: installed,
      command,
      binaryPath: installed ? command : null,
      version: null,
      authMethod: null,
      loginStatusText: null,
      error: installed
        ? null
        : "codex-acp is not installed. Run `bun add @zed-industries/codex-acp`.",
    };
  }
}

export const codexService = new CodexService();
