/**
 * Application menu.
 *
 * Not cosmetic on macOS: without an Edit menu, the standard Cmd+C/V/X/A/Z
 * accelerators do not reach the renderer at all, which would break copy/paste in
 * the xterm terminals and every text input in the app. Role-based items give us
 * the OS-native behaviour for free.
 */

import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

import { logFilePath } from "./logger.ts";

const isMac = process.platform === "darwin";

function appMenu(): MenuItemConstructorOptions[] {
  if (!isMac) {
    return [];
  }
  return [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
  ];
}

function fileMenu(): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [isMac ? { role: "close" } : { role: "quit" }],
  };
}

function editMenu(): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? ([{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }] as const)
        : ([{ role: "delete" }, { type: "separator" }, { role: "selectAll" }] as const)),
    ],
  };
}

function viewMenu(): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
}

function windowMenu(): MenuItemConstructorOptions {
  return {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? ([
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ] as const)
        : ([{ role: "close" }] as const)),
    ],
  };
}

function helpMenu(): MenuItemConstructorOptions {
  return {
    role: "help",
    submenu: [
      {
        click: () => {
          const path = logFilePath();
          if (path !== null) {
            // Reveal rather than open: the default handler for .log is unpredictable.
            shell.showItemInFolder(path);
          }
        },
        label: "Show Logs",
      },
    ],
  };
}

export function buildMenu(_window: BrowserWindow): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...appMenu(),
      fileMenu(),
      editMenu(),
      viewMenu(),
      windowMenu(),
      helpMenu(),
    ]),
  );
}
