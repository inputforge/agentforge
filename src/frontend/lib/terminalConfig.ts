import type { ITerminalOptions } from "@xterm/xterm";

export const FORGE_THEME = {
  background: "#080706",
  black: "#1a1918",
  blue: "#3b82f6",
  brightBlack: "#3d3a36",
  brightBlue: "#60a5fa",
  brightCyan: "#a5f3fc",
  brightGreen: "#4ade80",
  brightMagenta: "#c084fc",
  brightRed: "#f87171",
  brightWhite: "#f5f0e8",
  brightYellow: "#fbbf24",
  cursor: "#67e8f9",
  cursorAccent: "#080706",
  cyan: "#67e8f9",
  foreground: "#ede8df",
  green: "#22c55e",
  magenta: "#a855f7",
  red: "#ef4444",
  selectionBackground: "#67e8f930",
  white: "#ede8df",
  yellow: "#f59e0b",
};

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: FORGE_THEME,
};
