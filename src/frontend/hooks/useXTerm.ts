import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'

const FORGE_THEME = {
  background: '#080808',
  foreground: '#c8c8c8',
  cursor: '#f59e0b',
  cursorAccent: '#080808',
  selectionBackground: '#f59e0b33',
  black: '#1a1a1a',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#d4d4d4',
  brightBlack: '#404040',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#f5f5f5',
}

/**
 * Mounts an xterm terminal into `containerRef`, opens a WebSocket at `wsUrl`,
 * and wires up bidirectional I/O (keyboard input, resize) automatically.
 *
 * Pass `wsUrl = null` to defer connection (e.g. while creating a session).
 *
 * Returns:
 * - `containerRef` — attach to the host `<div>`
 * - `send(data)` — send a raw input string to the PTY
 */
export function useXTerm(wsUrl: string | null) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!wsUrl || !containerRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.4,
      theme: FORGE_THEME,
      convertEol: true,
      scrollback: 5000,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}${wsUrl}`)
    wsRef.current = ws

    ws.onopen = () => terminal.focus()
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      terminal.write(e.data)
    }
    ws.onclose = () => terminal.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n')
    ws.onerror = () => terminal.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n')

    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
      }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      ws.close()
      terminal.dispose()
      wsRef.current = null
    }
  }, [wsUrl])

  function send(data: string) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }))
    }
  }

  return { containerRef, send }
}
