/**
 * The browser window, and how the renderer gets loaded.
 *
 * ── Why a custom scheme instead of file:// ──────────────────────────────────────
 * Killing the HTTP server removed the `http://localhost` origin, and `file://` is
 * not a usable replacement — it yields an *opaque* origin, which breaks three
 * things this renderer actually does:
 *
 *   1. ES module scripts. The build emits root-absolute `<script type="module"
 *      crossorigin>` tags; module fetches from an opaque origin are CORS-blocked.
 *   2. `new Worker(url, { type: "module" })` — src/frontend/components/AgentDiffPanel.tsx
 *      imports `@pierre/diffs/worker/worker.js?worker&url` and constructs a module
 *      worker. Same CORS block, plus `worker.format: "es"` in vite.config.ts.
 *   3. `react-router-dom@7`'s BrowserRouter (src/frontend/main.tsx) — the History API
 *      needs a real origin, and root-absolute asset paths need a root to be
 *      relative to.
 *
 * Also: shiki is dynamically imported as ~300 lazy chunks, so every one of those
 * would hit the same module-CORS wall.
 *
 * So: a custom *standard* scheme, `app://`, registered as privileged before ready
 * and handled with `protocol.handle` + `net.fetch` after ready. Standard + secure
 * gives us a normal tuple origin (`app://bundle`), which makes modules, workers,
 * fetch and the History API all behave exactly as they did over http://localhost —
 * without opening a port.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { app, BrowserWindow, protocol, session, shell } from "electron";

import { createLogger } from "./logger.ts";
import { MIN_SIZE, restoreWindowState, trackWindowState } from "./windowState.ts";

const log = createLogger("window");

/** Custom scheme. Must be registered as privileged before `app.whenReady()`. */
export const APP_SCHEME = "app";
/** Fixed host, so the origin is a stable `app://bundle`. */
const APP_HOST = "bundle";
/** Where the renderer is served from in production. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const DEV_SERVER_URL = "http://localhost:5173";

/** Dev iff Vite is expected to be up. Set by the `dev:electron` scripts. */
export function isDev(): boolean {
  return !!process.env.AGENTFORGE_DEV;
}

/**
 * Content types for everything the Vite build emits.
 *
 * Set explicitly rather than trusting `net.fetch`'s file:// sniffing: a module
 * script served as the wrong type is refused outright by the strict MIME check,
 * and that failure is invisible until a lazy chunk 404s at runtime.
 */
const MIME_TYPES: Record<string, string> = {
  css: "text/css",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Register the scheme's privileges. MUST be called before `app.whenReady()` —
 * Electron reads this table when the network service starts, and a later call is
 * silently ignored.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        // A tuple origin, so modules/workers/History API work (the whole point).
        standard: true,
        // Treated as trustworthy: no mixed-content warnings, and it satisfies
        // secure-context gates.
        secure: true,
        // `fetch()` and module/worker loads go through the handler.
        supportFetchAPI: true,
        // Same-origin requests skip preflight instead of being blocked.
        corsEnabled: true,
        // Stream responses rather than buffering whole chunks in memory.
        stream: true,
      },
      scheme: APP_SCHEME,
    },
  ]);
}

/**
 * Directory containing package.json — the anchor for every bundled path.
 *
 * `app.getAppPath()`, not a source-relative directory: build-time paths point into
 * the source tree and do not exist on a user's machine. `getAppPath()` is resolved
 * by Electron at runtime and is symmetric across dev
 * and packaged *provided* Electron is pointed at the project (`electron .`) rather
 * than at the script (`electron out/electron/main.cjs`) — the latter returns
 * out/electron instead of the root. Both `dev:electron` scripts use `electron .`
 * for exactly this reason.
 *
 *   dev:      <repo>/                    → <repo>/out/client
 *   packaged: …/Resources/app.asar       → app.asar/out/client
 */
function appRoot(): string {
  return app.getAppPath();
}

/** Absolute path to the built renderer. */
function clientDir(): string {
  return join(appRoot(), "out", "client");
}

/** Absolute path to the bundled preload. Always a sibling of main.js. */
export function preloadPath(): string {
  return join(appRoot(), "out", "electron", "preload.cjs");
}

/** Is `candidate` inside `root`? Prefix check on resolved, separator-terminated paths. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Serve a file as a streamed response.
 *
 * Reads through `node:fs` rather than `net.fetch(pathToFileURL(path))`. The whole
 * renderer lives *inside* app.asar when packaged (`asarUnpack` only pulls out
 * node-pty), so asar transparency is a hard requirement here.
 *
 * Both approaches were measured against the real packaged app.asar and both work —
 * `net.fetch` on a file:// URL inside the archive returns 200. `createReadStream` is
 * kept anyway: asar virtualisation is an fs-layer patch in *this* process, so fs is
 * asar-aware by construction, whereas net.fetch's file:// handling routes through
 * the network service and is asar-aware only incidentally. `Readable.toWeb` keeps it
 * streaming rather than buffering 1.3MB chunks.
 */
function serveFile(path: string): Response {
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      "Content-Type": mimeFor(path),
      // Hashed filenames are immutable; index.html must never be cached, or a
      // stale one would point at chunks that no longer exist after an update.
      "Cache-Control": path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
    },
    status: 200,
  });
}

/**
 * Serve out/client over `app://`.
 *
 * Must be called after `app.whenReady()`.
 */
export function registerAppProtocol(): void {
  const root = clientDir();
  const indexHtml = join(root, "index.html");

  if (!existsSync(indexHtml)) {
    log.error(
      `renderer bundle missing at ${indexHtml}. Run \`npm run build:frontend\` ` +
        "(or `npm run build`) before starting Electron in production mode.",
    );
  }

  protocol.handle(APP_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // One origin only. A different host is a different origin, and serving the
    // same bundle under both would split localStorage/IndexedDB in half.
    if (url.hostname !== APP_HOST) {
      return new Response("Not Found", { status: 404 });
    }

    // Decode BEFORE resolving: `%2e%2e%2f` survives URL's own normalisation and
    // only becomes `../` here, so the traversal check must come after decoding.
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // NUL truncates paths in some syscalls; reject rather than normalise.
    if (decoded.includes("\0")) {
      return new Response("Bad Request", { status: 400 });
    }

    const target = resolve(join(root, decoded));

    if (!isInside(root, target)) {
      log.warn(`blocked path traversal: ${request.url}`);
      return new Response("Forbidden", { status: 403 });
    }

    if (isFile(target)) {
      try {
        return serveFile(target);
      } catch (error) {
        log.error(`failed to read ${target}:`, error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // History-API deep links (BrowserRouter) have no file on disk — hand them
    // index.html and let the router match client-side.
    //
    // Gated on Accept: only *navigations* get the fallback. A missing .js chunk
    // must 404 honestly; answering it with HTML turns a clean "chunk missing"
    // into an inscrutable "Unexpected token '<'".
    const accept = request.headers.get("Accept") ?? "";
    if (accept.includes("text/html") && isFile(indexHtml)) {
      return serveFile(indexHtml);
    }

    return new Response("Not Found", { status: 404 });
  });

  log.info(`serving ${APP_ORIGIN} from ${root}`);
}

// ─── CSP ──────────────────────────────────────────────────────────────────────

/**
 * The renderer displays agent-authored markdown, so treat it as a page that will
 * eventually be fed something hostile.
 *
 * `'unsafe-inline'` for style-src is unavoidable: xterm.js injects a <style> block
 * at runtime and React sets inline styles. Scripts get no such exception in
 * production.
 *
 * `'self'` here means `app://bundle` — which only works because the scheme is
 * registered as `standard`. Under file:// the origin would be opaque and `'self'`
 * would match nothing.
 */
export function cspFor(dev: boolean): string {
  return [
    "default-src 'self'",
    dev
      ? // Vite injects inline bootstrap scripts and react-refresh evaluates
        // transformed modules. Neither exception ships to production.
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // data: for inline SVG icons, blob: for generated images.
    "img-src 'self' data: blob:",
    // 'self' for the emitted .woff2 files; data: because Vite inlines every font
    // subset under assetsInlineLimit (4096B) directly into the CSS as a
    // `data:font/woff2;base64,…` URI. Verified in the real build: 8 of the 36
    // @fontsource subsets are inlined, and `font-src 'self'` alone silently blocks
    // all 8 — the app renders in a fallback font with only a console error to show
    // for it. No remote font origin either way.
    "font-src 'self' data:",
    dev ? "connect-src 'self' ws://localhost:5173 http://localhost:5173" : "connect-src 'self'",
    // blob: — bundlers emit blob workers for some chunk shapes.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // No <iframe>/<embed> surface at all.
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Attach the CSP to every response. Must be called after `app.whenReady()`. */
export function applyCsp(): void {
  const csp = cspFor(isDev());
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
  log.info(`CSP: ${csp}`);
}

/**
 * May the OS browser be handed this URL?
 *
 * https only. http is downgrade-prone, and handing `file:///…` to the OS opener
 * would let agent-authored markdown open arbitrary local paths.
 */
function isExternallyOpenable(target: string): boolean {
  try {
    return new URL(target).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Lock down navigation for a window's webContents.
 *
 * This is not hypothetical: src/frontend/components/AgentAcpPanel.tsx renders
 * *agent-authored* markdown, and its link renderer sets `target="_blank"`. In a
 * browser that is a tab; in Electron an unhandled `window.open` spawns a real
 * BrowserWindow with no guarantees about what it loads. An agent that writes a
 * link is, effectively, untrusted input with a window handle.
 */
function hardenNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url);
    } else {
      log.warn(`blocked window.open: ${url}`);
    }
    // Never let Electron create the window; either the OS browser took it or it
    // was refused.
    return { action: "deny" };
  });

  // `target="_blank"` goes through setWindowOpenHandler, but a plain markdown
  // link navigates the app window itself — which would replace the whole UI with
  // whatever the agent linked to, with no way back.
  window.webContents.on("will-navigate", (event, url) => {
    const allowedPrefix = isDev() ? DEV_SERVER_URL : APP_ORIGIN;
    if (url.startsWith(allowedPrefix)) {
      return;
    }
    event.preventDefault();
    if (isExternallyOpenable(url)) {
      void shell.openExternal(url);
    } else {
      log.warn(`blocked navigation: ${url}`);
    }
  });
}

/**
 * Load the Vite dev server, retrying until it is up.
 *
 * `concurrently` starts Vite and Electron together and cannot order them, so
 * Electron reaching `loadURL` first is a coin flip. Retrying here beats adding a
 * `wait-on` dependency, and beats the alternative failure mode: a blank window
 * whose only clue is ERR_CONNECTION_REFUSED in a log the user never opens.
 */
function loadDevServer(window: BrowserWindow, attempt = 1): void {
  const MAX_ATTEMPTS = 40; // ~20s at 500ms
  window.loadURL(DEV_SERVER_URL).catch((error: unknown) => {
    if (window.isDestroyed()) {
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      log.error(`dev server never came up at ${DEV_SERVER_URL}:`, error);
      return;
    }
    if (attempt === 1) {
      log.info(`waiting for the vite dev server at ${DEV_SERVER_URL}…`);
    }
    setTimeout(() => loadDevServer(window, attempt + 1), 500);
  });
}

export function createWindow(): BrowserWindow {
  const state = restoreWindowState();

  const window = new BrowserWindow({
    backgroundColor: "#0a0a0a",
    // Restored, not hardcoded — and already validated against the current displays, so
    // these coordinates are known to be on screen. See windowState.ts.
    ...state.bounds,
    minHeight: MIN_SIZE.height,
    minWidth: MIN_SIZE.width,
    show: false,
    title: "AgentForge",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Enables the Window Controls Overlay: the `titlebar-area-*` CSS env vars and
    // `navigator.windowControlsOverlay`. `.app-titlebar` (src/frontend/index.css) reads
    // `env(titlebar-area-x)` to reserve exactly the width the traffic lights occupy,
    // rather than hardcoding a measured pixel count that macOS is free to change.
    //
    // Two reasons this is an env var and not a constant:
    //   - In native macOS fullscreen the lights move into a separate NSView that slides
    //     down over the content, so the vars go unpopulated and the reservation must
    //     collapse to 0 — otherwise fullscreen carries a dead 78px gutter forever.
    //   - Windows keeps its native title bar (`titleBarStyle: "default"`), where nothing
    //     overlaps the content; the vars are absent and the fallback is 0. Correct there.
    //
    // The docs label `titleBarOverlay` "_Windows_ _Linux_", but that is stale: Electron's
    // own `NativeWindow::IsWindowControlsOverlayEnabled()` has an `IS_MAC` branch gated on
    // `TitleBarStyle::kHiddenInset`, and api-browser-window-spec.ts covers it on macOS.
    // Gated to darwin anyway — it is inert next to a `default` title bar, and pairing an
    // overlay with a native bar is not a combination worth relying on.
    titleBarOverlay: process.platform === "darwin",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath(),
      // The renderer needs no Node: `rg 'require\(|node:|__dirname' src/frontend`
      // is zero hits. Everything privileged goes through the preload bridge.
      sandbox: true,
      webSecurity: true,
    },
  });

  // Applied after construction: BrowserWindow takes no maximised/fullscreen option, and
  // both must be set before `show()` so the window never appears at the wrong size first.
  if (state.isMaximized) {
    window.maximize();
  }
  if (state.isFullScreen) {
    window.setFullScreen(true);
  }
  trackWindowState(window);

  hardenNavigation(window);

  // Avoid the white flash before React paints.
  window.once("ready-to-show", () => window.show());

  window.webContents.on("render-process-gone", (_event, details) => {
    log.error("renderer process gone:", details.reason, details.exitCode);
  });

  window.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    // -3 is ERR_ABORTED, which fires for ordinary cancelled navigations.
    if (code === -3) {
      return;
    }
    log.error(`did-fail-load ${code} ${description}: ${validatedURL}`);
  });

  if (isDev()) {
    log.info(`loading dev server ${DEV_SERVER_URL}`);
    loadDevServer(window);
  } else {
    // Load the origin ROOT, not `/index.html`. The protocol handler serves index.html
    // for either, but the URL becomes the router's location: `/index.html` matches no
    // <Route> (they are `/` and `/agent/:ticketId`), so the app renders a blank window.
    void window.loadURL(`${APP_ORIGIN}/`);
  }

  return window;
}
