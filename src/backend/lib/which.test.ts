import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { isExecutableFile, whichSync } from "./which.ts";

/**
 * This is the only thing standing between the app and both agent binaries: AgentForge
 * ships neither `claude` nor `codex-acp`, so every agent lookup goes through here.
 */

let dir: string;
let binDir: string;
let otherDir: string;
const ORIGINAL_PATH = process.env.PATH;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "which-test-"));
  binDir = join(dir, "bin");
  otherDir = join(dir, "other");
  mkdirSync(binDir);
  mkdirSync(otherDir);

  // An executable, a non-executable, and a directory that shadows a real name.
  writeFileSync(join(binDir, "tool-exec"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "tool-exec"), 0o755);
  writeFileSync(join(binDir, "tool-noexec"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "tool-noexec"), 0o644);
  mkdirSync(join(binDir, "tool-dir"));

  // Same name in both dirs; the earlier PATH entry must win.
  writeFileSync(join(otherDir, "tool-dup"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(otherDir, "tool-dup"), 0o755);
  writeFileSync(join(binDir, "tool-dup"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "tool-dup"), 0o755);
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(dir, { force: true, recursive: true });
});

describe("isExecutableFile", () => {
  test("true only for an existing, executable, regular file", () => {
    expect(isExecutableFile(join(binDir, "tool-exec"))).toBe(true);
    // 644 is exactly node-pty's spawn-helper bug: present but not executable.
    expect(isExecutableFile(join(binDir, "tool-noexec"))).toBe(false);
    expect(isExecutableFile(join(binDir, "tool-dir"))).toBe(false);
    expect(isExecutableFile(join(binDir, "tool-absent"))).toBe(false);
  });
});

describe("whichSync", () => {
  test("finds a bare name on PATH", () => {
    process.env.PATH = [binDir, otherDir].join(delimiter);
    expect(whichSync("tool-exec")).toBe(join(binDir, "tool-exec"));
  });

  test("returns null for a name that is on PATH but not executable", () => {
    process.env.PATH = binDir;
    expect(whichSync("tool-noexec")).toBeNull();
  });

  test("returns null for a name that is not on PATH at all", () => {
    process.env.PATH = binDir;
    expect(whichSync("definitely-not-installed")).toBeNull();
  });

  test("earlier PATH entries win", () => {
    process.env.PATH = [otherDir, binDir].join(delimiter);
    expect(whichSync("tool-dup")).toBe(join(otherDir, "tool-dup"));
    process.env.PATH = [binDir, otherDir].join(delimiter);
    expect(whichSync("tool-dup")).toBe(join(binDir, "tool-dup"));
  });

  test("does not mistake a directory for an executable", () => {
    process.env.PATH = binDir;
    expect(whichSync("tool-dir")).toBeNull();
  });

  test("skips empty PATH segments rather than resolving against cwd", () => {
    // A trailing/doubled delimiter historically means "cwd" in some shells; treating it
    // that way in a GUI app (cwd `/`) would resolve arbitrary binaries.
    process.env.PATH = ["", binDir, ""].join(delimiter);
    expect(whichSync("tool-exec")).toBe(join(binDir, "tool-exec"));
  });

  test("an explicit path bypasses PATH and is checked directly", () => {
    process.env.PATH = otherDir; // deliberately does NOT contain tool-exec
    expect(whichSync(join(binDir, "tool-exec"))).toBe(join(binDir, "tool-exec"));
    expect(whichSync(join(binDir, "tool-noexec"))).toBeNull();
    expect(whichSync(join(binDir, "tool-absent"))).toBeNull();
  });

  test("returns null when PATH is unset", () => {
    delete process.env.PATH;
    expect(whichSync("tool-exec")).toBeNull();
  });
});
