import { existsSync } from "fs";
import { join } from "path";
import type { CodexStatus } from "../../common/types.ts";

const decoder = new TextDecoder();
const projectRoot = join(import.meta.dir, "../../..");
const localCodexBinary = join(
  projectRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);

function decodeOutput(output: Uint8Array | undefined): string {
  return output ? decoder.decode(output).trim() : "";
}

function cleanCodexOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"),
    )
    .join("\n");
}

function parseVersion(output: string): string | null {
  const match = output.match(/codex-cli\s+([^\s]+)/i);
  return match?.[1] ?? null;
}

function parseAuthMethod(output: string): CodexStatus["authMethod"] {
  const normalized = output.toLowerCase();
  if (normalized.includes("chatgpt")) return "chatgpt";
  if (normalized.includes("api key")) return "apikey";
  if (normalized.includes("agent identity")) return "agentIdentity";
  if (normalized.includes("logged in")) return "unknown";
  return null;
}

function isAuthenticated(output: string): boolean {
  return /logged in/i.test(output) && !/not logged in/i.test(output);
}

export class CodexService {
  resolveBinaryPath(): string | null {
    const override = process.env.AGENTFORGE_CODEX_BIN?.trim();
    if (override) return override;
    if (existsSync(localCodexBinary)) return localCodexBinary;
    return null;
  }

  buildLaunchCommand(prompt: string): string {
    const binary = this.resolveBinaryPath() ?? "codex";
    const quotedBinary = `"${binary.replace(/"/g, '\\"')}"`;
    return prompt.trim() ? `${quotedBinary} -- ${shellQuote(prompt.trim())}` : quotedBinary;
  }

  buildAppServerCommand(): string {
    const binary = this.resolveBinaryPath() ?? "codex";
    return `"${binary.replace(/"/g, '\\"')}" app-server`;
  }

  async getStatus(): Promise<CodexStatus> {
    const binaryPath = this.resolveBinaryPath();
    const command = binaryPath ?? "codex";

    if (!binaryPath) {
      return {
        installed: false,
        authenticated: false,
        ready: false,
        command,
        binaryPath: null,
        version: null,
        authMethod: null,
        loginStatusText: null,
        error: "Codex is not installed locally. Run `bun install` to add the bundled CLI.",
      };
    }

    const versionProc = Bun.spawnSync([binaryPath, "--version"], {
      cwd: projectRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const versionOutput = [decodeOutput(versionProc.stdout), decodeOutput(versionProc.stderr)]
      .filter(Boolean)
      .join("\n");
    const version = parseVersion(versionOutput);

    const loginProc = Bun.spawnSync([binaryPath, "login", "status"], {
      cwd: projectRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const loginStatusText = cleanCodexOutput(
      [decodeOutput(loginProc.stdout), decodeOutput(loginProc.stderr)].filter(Boolean).join("\n"),
    );
    const authenticated = isAuthenticated(loginStatusText);
    const authMethod = parseAuthMethod(loginStatusText);

    return {
      installed: true,
      authenticated,
      ready: authenticated,
      command,
      binaryPath,
      version,
      authMethod,
      loginStatusText: loginStatusText || null,
      error: authenticated
        ? null
        : "Codex is installed locally but not signed in. Run `./node_modules/.bin/codex login`.",
    };
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export const codexService = new CodexService();
