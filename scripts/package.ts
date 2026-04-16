import { join } from "path";

const projectRoot = join(import.meta.dir, "..");
const distDir = join(projectRoot, "dist");
const pkgDir = join(projectRoot, "pkg");

const staticFiles = ["README.md", "LICENSE"].map((f) => join(projectRoot, f));

await Bun.$`mkdir -p ${pkgDir}`;

const glob = new Bun.Glob("*/agentforge{,.exe}");
const found: string[] = [];
for await (const rel of glob.scan({ cwd: distDir, onlyFiles: true })) {
  found.push(rel);
}

if (found.length === 0) {
  console.error("No built executables found in dist/. Run `bun run build` first.");
  process.exit(1);
}

await Promise.all(
  found.map(async (rel) => {
    const [dir] = rel.split("/");
    const target = dir;
    if (target === "native") return;
    const zipName = `agentforge-${target}.zip`;
    const zipPath = join(pkgDir, zipName);
    const executable = join(distDir, rel);

    const proc = Bun.spawn(["zip", "-j", zipPath, executable, ...staticFiles], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`Failed to create ${zipName}: ${err}`);
    }
    console.log(`Packaged ${zipName}`);
  }),
);
