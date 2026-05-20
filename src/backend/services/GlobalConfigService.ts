import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".agentforge");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface GlobalConfig {
  integrations?: {
    github?: { pat?: string };
    linear?: { pat?: string };
  };
}

function read(): GlobalConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as GlobalConfig;
  } catch {
    return {};
  }
}

function write(config: GlobalConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  chmodSync(CONFIG_PATH, 0o600);
}

export const globalConfig = {
  deletePat(provider: "github" | "linear"): void {
    const config = read();
    if (config.integrations?.[provider]) {
      delete config.integrations[provider]!.pat;
    }
    write(config);
  },

  getPat(provider: "github" | "linear"): string | null {
    return read().integrations?.[provider]?.pat ?? null;
  },

  setPat(provider: "github" | "linear", pat: string): void {
    const config = read();
    config.integrations ??= {};
    config.integrations[provider] ??= {};
    config.integrations[provider]!.pat = pat;
    write(config);
  },
};
