import type { ITerminalOptions } from "@xterm/xterm";

export const FORGE_THEME = {
  background: "#080706",
  foreground: "#ede8df",
  cursor: "#67e8f9",
  cursorAccent: "#080706",
  selectionBackground: "#67e8f930",
  black: "#1a1918",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#67e8f9",
  white: "#ede8df",
  brightBlack: "#3d3a36",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#a5f3fc",
  brightWhite: "#f5f0e8",
};

export const TERMINAL_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 14,
  theme: FORGE_THEME,
  scrollback: 5000,
};
