import { isAbsolute } from "node:path";

import type { CodexStatus } from "../../common/types.ts";
import { isExecutableFile, whichSync } from "../lib/which.ts";

const BINARY_NAME = "codex-acp";

export const NOT_INSTALLED_ERROR =
  "codex-acp was not found. Set CODEX_ACP_PATH to the codex-acp binary, or install it so that it is on your PATH.";

export class CodexService {
  /**
   * Resolution order: `CODEX_ACP_PATH` (an explicit override) → PATH lookup → null.
   *
   * AgentForge does not ship codex-acp; the user installs it. There is no bare-name
   * fallback, because a bare name is not runnable from a Dock launch, where PATH is
   * `/usr/bin:/bin:/usr/sbin:/sbin` until resolveUserPath() repairs it.
   */
  resolveBinaryPath(): string | null {
    const configured = process.env.CODEX_ACP_PATH;
    if (configured) {
      return isExecutableFile(configured) ? configured : null;
    }
    return whichSync(BINARY_NAME);
  }

  getStatus(): Promise<CodexStatus> {
    const binaryPath = this.resolveBinaryPath();
    const installed = binaryPath !== null;
    const configured = process.env.CODEX_ACP_PATH;

    let error: string | null = null;
    if (!installed) {
      error =
        configured === undefined || configured === ""
          ? NOT_INSTALLED_ERROR
          : `CODEX_ACP_PATH is set to "${configured}" but that is not an executable file.` +
            (isAbsolute(configured) ? "" : " CODEX_ACP_PATH must be an absolute path.");
    }

    return Promise.resolve({
      authMethod: null,
      authenticated: installed,
      binaryPath,
      // Null when unresolved: there is no command we could actually run.
      command: binaryPath,
      error,
      installed,
      loginStatusText: null,
      ready: installed,
      version: null,
    });
  }
}

export const codexService = new CodexService();
