import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CodexStatus } from "../../common/types.ts";

const projectRoot = join(import.meta.dir, "../../..");

export class CodexService {
  resolveBinaryPath(): string {
    const local = join(projectRoot, "node_modules/.bin/codex-acp");
    if (existsSync(local)) {
      return local;
    }
    return "codex-acp";
  }

  getStatus(): Promise<CodexStatus> {
    const command = this.resolveBinaryPath();
    let installed: boolean;
    let binaryPath: string | null;

    if (command === "codex-acp") {
      const which = Bun.which("codex-acp");
      installed = which !== null;
      binaryPath = which;
    } else {
      installed = existsSync(command);
      binaryPath = installed ? command : null;
    }

    return Promise.resolve({
      authMethod: null,
      authenticated: installed,
      binaryPath,
      command,
      error: installed
        ? null
        : "codex-acp is not installed. Run `bun add @zed-industries/codex-acp`.",
      installed,
      loginStatusText: null,
      ready: installed,
      version: null,
    });
  }
}

export const codexService = new CodexService();
