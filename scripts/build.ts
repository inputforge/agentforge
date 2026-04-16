import { join, relative } from "path";
import type { CompileBuildOptions } from "bun";

const projectRoot = import.meta.dir;
const clientDir = join(projectRoot, "../out/client");

const MIME_TYPES: Record<string, string> = {
  html: "text/html;charset=utf-8",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json",
  txt: "text/plain",
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
    const relFromBackend = relative(join(projectRoot, "src/backend"), absPath).replace(/\\/g, "/");
    const varName = `_a${idx++}`;
    const normalizedRel = rel.replace(/\\/g, "/");
    const isIndex = normalizedRel === "index.html";
    const urlPath = isIndex ? "/index" : "/" + normalizedRel;

    imports.push(`import ${varName} from ${JSON.stringify(relFromBackend)} with { type: "file" };`);
    entries.push(
      `  { path: ${JSON.stringify(urlPath)}, type: ${JSON.stringify(mimeFor(rel))}, file: ${varName} }`,
    );
    if (isIndex) indexVar = varName;
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
      entrypoints: ["./src/backend/main.ts"],
      outdir: `./dist/${target?.replace("bun-", "") ?? "native"}`,
      target: "bun",
      minify: true,
      files: {
        [join(projectRoot, "src/backend/assets.ts")]: assetsModule,
      },
      compile,
    });
  }),
);
