import { join, relative } from "node:path";

import type { CompileBuildOptions } from "bun";

const projectRoot = join(import.meta.dir, "..");
const clientDir = join(projectRoot, "out/client");

const MIME_TYPES: Record<string, string> = {
  css: "text/css",
  gif: "image/gif",
  html: "text/html;charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript",
  json: "application/json",
  map: "application/json",
  mjs: "application/javascript",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

async function generateAssetsModule(): Promise<string> {
  if (!(await Bun.file(join(clientDir, "index.html")).exists())) {
    throw new Error(
      `Frontend build output not found at ${clientDir}. Run 'bun run build:frontend' first.`,
    );
  }

  const glob = new Bun.Glob("**/*");
  const imports: string[] = [];
  const entries: string[] = [];
  let indexVar: string | null = null;
  let idx = 0;

  for await (const rel of glob.scan({ cwd: clientDir, onlyFiles: true })) {
    const absPath = join(clientDir, rel);
    const relFromBackend = relative(join(projectRoot, "src/backend"), absPath).replaceAll(
      "\\",
      "/",
    );
    const varName = `_a${(idx += 1)}`;
    const normalizedRel = rel.replaceAll("\\", "/");
    const isIndex = normalizedRel === "index.html";
    const urlPath = isIndex ? "/index" : `/${normalizedRel}`;

    imports.push(`import ${varName} from ${JSON.stringify(relFromBackend)} with { type: "file" };`);
    entries.push(
      `  { path: ${JSON.stringify(urlPath)}, type: ${JSON.stringify(mimeFor(rel))}, file: ${varName} }`,
    );
    if (isIndex) {
      indexVar = varName;
    }
  }

  const indexExport = indexVar
    ? `export const index: Asset = { path: "/index", type: ${JSON.stringify(MIME_TYPES.html)}, file: ${indexVar} };`
    : `export const index: Asset | null = null;`;

  return [
    ...imports,
    "",
    "export type Asset = { path: string; type: string; file: string };",
    "export const assets: Asset[] = [",
    entries.join(",\n"),
    "];",
    indexExport,
  ].join("\n");
}

const assetsModule = await generateAssetsModule();

const targets: CompileBuildOptions["target"][] =
  Bun.argv[2] === "all"
    ? [
        "bun-darwin-x64",
        "bun-darwin-arm64",
        "bun-linux-x64",
        "bun-linux-arm64",
        "bun-windows-x64",
        "bun-windows-arm64",
      ]
    : [undefined];

await Promise.all(
  targets.map((target) => {
    const compile: CompileBuildOptions = {
      outfile: "agentforge",
    };

    if (target) {
      compile.target = target;
    }

    console.log(`Building for ${target ?? "native"}`);
    return Bun.build({
      compile,
      entrypoints: ["./src/backend/main.ts"],
      files: {
        [join(projectRoot, "src/backend/assets.ts")]: assetsModule,
      },
      minify: true,
      outdir: `./dist/${target?.replace("bun-", "") ?? "native"}`,
      target: "bun",
    });
  }),
);
