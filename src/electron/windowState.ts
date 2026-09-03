/**
 * Window size, position and maximised/fullscreen state, remembered across launches.
 *
 * A desktop app is expected to reopen where you left it; a browser tab is not. Every
 * launch used to be a hardcoded 1440x900, so any resize or move was silently discarded.
 *
 * The size is clamped to the work area rather than trusted, because 1440x900 does not
 * universally fit the machine this most often runs on: a 14" MacBook is 1512x982, whose
 * work area measures 1512x940 with the Dock hidden — but only ~1512x870 with the Dock
 * visible, which is the default. The height alone overflows there.
 *
 * State is app-scoped (`<userData>/window-state.json`) rather than repo-scoped: it
 * describes the window, not the project, and switching repos should not move the window.
 * Same read/narrow/best-effort-write shape as repoRegistry.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { app, screen, type BrowserWindow, type Rectangle } from "electron";

import { createLogger } from "./logger.ts";

const log = createLogger("window-state");

interface WindowState {
  /**
   * The *normal* (neither maximised nor fullscreen) frame. Kept separately from the
   * flags below so that un-maximising after a restart returns the window to the size it
   * had before it was maximised, rather than leaving it filling the display.
   */
  bounds: Rectangle;
  isMaximized: boolean;
  isFullScreen: boolean;
}

/** Preferred first-run size. Clamped to the work area — see `defaultBounds()`. */
const DEFAULT_SIZE = { height: 900, width: 1440 };

/** Below this the board's four columns hit their min width and start scrolling. */
export const MIN_SIZE = { height: 600, width: 940 };

/**
 * A restored window must overlap a live display by at least this much, or it is
 * unreachable: a display that has been unplugged or rearranged since the last launch
 * leaves saved coordinates pointing into empty space. The vertical figure is the
 * `.app-titlebar` height — the title bar is the only way to drag the window back, so if
 * it is off-screen the window cannot be recovered by hand at all.
 */
const MIN_VISIBLE = { x: 120, y: 40 };

/** How long to coalesce resize/move events before writing. */
const SAVE_DEBOUNCE_MS = 400;

function statePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBounds(raw: unknown): Rectangle | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const { x, y, width, height } = raw as Partial<Record<keyof Rectangle, unknown>>;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  // A zero/negative size would create an invisible window that looks like a crash.
  if (width < MIN_SIZE.width || height < MIN_SIZE.height) {
    return null;
  }
  return { height, width, x, y };
}

/** Narrow unknown JSON to the state shape. Any malformed field discards the whole file. */
function parseState(raw: unknown): WindowState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Partial<Record<keyof WindowState, unknown>>;
  const bounds = parseBounds(candidate.bounds);
  if (bounds === null) {
    return null;
  }
  return {
    bounds,
    isFullScreen: candidate.isFullScreen === true,
    isMaximized: candidate.isMaximized === true,
  };
}

function readState(): WindowState | null {
  const file = statePath();
  if (!existsSync(file)) {
    return null;
  }
  try {
    return parseState(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    log.warn(`${file} is unreadable; falling back to the default window:`, error);
    return null;
  }
}

function writeState(state: WindowState): void {
  const file = statePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Sync, and sync on purpose: the last write happens on `close`, racing app teardown.
    // An async write there is simply lost, which is the one case that matters most.
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    // Losing this costs a default-sized window next launch. Never worth failing over.
    log.warn(`could not persist ${file}:`, error);
  }
}

/** Does `bounds` overlap any display enough to be seen and grabbed? */
function isReachable(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_VISIBLE.x && overlapY >= MIN_VISIBLE.y;
  });
}

/**
 * Centre a window of `size` on the primary display, clamping it to the work area.
 *
 * `workArea` rather than `size`: it excludes the menu bar and Dock, which a window
 * cannot occupy anyway.
 */
function centreOnPrimary(size: { width: number; height: number }): Rectangle {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  return {
    height,
    width,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

/**
 * The frame and flags to open with. Falls back to a centred window when the saved state is
 * missing or malformed (at the default size), or when it points somewhere no longer on
 * screen (at the saved size).
 *
 * Must be called after `app.whenReady()` — `screen` is unavailable before it.
 */
export function restoreWindowState(): WindowState {
  const saved = readState();
  if (saved === null) {
    return { bounds: centreOnPrimary(DEFAULT_SIZE), isFullScreen: false, isMaximized: false };
  }
  if (!isReachable(saved.bounds)) {
    log.warn("saved window bounds are off-screen (display changed?); centring instead");
    // Keep the size and the flags — only the *coordinates* stopped being valid. Falling
    // back to the full default here would throw away a window size the user chose, for a
    // reason (a display went away) that says nothing about how big they want the window.
    return { ...saved, bounds: centreOnPrimary(saved.bounds) };
  }
  return saved;
}

/** Persist `window`'s geometry as it changes. Call once, right after creating it. */
export function trackWindowState(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = (): void => {
    if (window.isDestroyed()) {
      return;
    }
    writeState({
      // getNormalBounds(), not getBounds(): while maximised or fullscreen the latter is
      // the display, and saving that would permanently lose the user's real window size.
      bounds: window.getNormalBounds(),
      isFullScreen: window.isFullScreen(),
      isMaximized: window.isMaximized(),
    });
  };

  const schedule = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    // resize/move fire continuously while dragging; one write per gesture is plenty.
    timer = setTimeout(persist, SAVE_DEBOUNCE_MS);
  };

  // Listed out rather than looped: `BrowserWindow.on` is typed as one overload per event
  // name, so a union of names matches none of them.
  window.on("resize", schedule);
  window.on("move", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);

  window.on("close", () => {
    // Flush: a gesture in the last SAVE_DEBOUNCE_MS before quitting would otherwise be
    // dropped, which is exactly the resize the user is most likely to expect to stick.
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    persist();
  });
}
