import { spawn } from "node:child_process";
import { join } from "path";
import type { CodexStatus } from "../../common/types.ts";

const decoder = new TextDecoder();
const projectRoot = join(import.meta.dir, "../../..");
const _rawTimeout = Number(process.env.AGENTFORGE_CODEX_STATUS_TIMEOUT_MS);
const statusProbeTimeoutMs = Number.isFinite(_rawTimeout)
  ? Math.max(1000, Math.min(60000, _rawTimeout))
  : 5000;

interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
}

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

function probeFailure(label: string, result: ProbeResult): string | null {
  if (result.timedOut) return `${label} timed out after ${statusProbeTimeoutMs}ms.`;
  if (result.error) return `${label} failed: ${result.error.message}`;
  if (result.exitCode !== 0) {
    const output = cleanCodexOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
    return `${label} exited with code ${result.exitCode ?? "unknown"}${output ? `: ${output}` : ""}`;
  }
  return null;
}

function runProbe(binaryPath: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const finish = (exitCode: number | null, error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: decodeOutput(Buffer.concat(stdout)),
        stderr: decodeOutput(Buffer.concat(stderr)),
        timedOut,
        error,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, statusProbeTimeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    proc.on("error", (err) => finish(null, err));
    proc.on("close", (code) => finish(code, null));
  });
}

export class CodexService {
  resolveBinaryPath(): string {
    const override = process.env.AGENTFORGE_CODEX_BIN?.trim();
    if (override) return override;
    return "codex";
  }

  buildLaunchCommand(prompt: string): string {
    const binary = this.resolveBinaryPath();
    const quotedBinary = `"${binary.replace(/"/g, '\\"')}"`;
    return prompt.trim() ? `${quotedBinary} -- ${shellQuote(prompt.trim())}` : quotedBinary;
  }

  buildAppServerCommand(): string {
    const binary = this.resolveBinaryPath();
    return `"${binary.replace(/"/g, '\\"')}" app-server`;
  }

  async getStatus(): Promise<CodexStatus> {
    const command = this.resolveBinaryPath();

    const versionProbe = await runProbe(command, ["--version"]);
    const versionFailure = probeFailure("Codex version probe", versionProbe);
    if (versionFailure) {
      const notOnPath = versionProbe.error?.message?.includes("ENOENT");
      return {
        installed: false,
        authenticated: false,
        ready: false,
        command,
        binaryPath: null,
        version: null,
        authMethod: null,
        loginStatusText: null,
        error: notOnPath
          ? "Codex is not installed. Run `npm install -g @openai/codex` or `bun add -g @openai/codex`."
          : versionFailure,
      };
    }

    const versionOutput = [versionProbe.stdout, versionProbe.stderr].filter(Boolean).join("\n");
    const version = parseVersion(versionOutput);

    const loginProbe = await runProbe(command, ["login", "status"]);
    const loginStatusText = cleanCodexOutput(
      [loginProbe.stdout, loginProbe.stderr].filter(Boolean).join("\n"),
    );
    const loginFailure = probeFailure("Codex login status probe", loginProbe);
    if (loginFailure) {
      return {
        installed: true,
        authenticated: false,
        ready: false,
        command,
        binaryPath: null,
        version,
        authMethod: null,
        loginStatusText: loginStatusText || null,
        error: loginFailure,
      };
    }

    const authenticated = isAuthenticated(loginStatusText);
    const authMethod = parseAuthMethod(loginStatusText);

    return {
      installed: true,
      authenticated,
      ready: authenticated,
      command,
      binaryPath: null,
      version,
      authMethod,
      loginStatusText: loginStatusText || null,
      error: authenticated ? null : "Codex is not signed in. Run `codex login`.",
    };
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export const codexService = new CodexService();
