import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../store/useAppStore'

const XTERM_THEME = {
  background: '#0f1115',
  foreground: '#e6e8ef',
  cursor: '#f0a84b',
  cursorAccent: '#0f1115',
  selectionBackground: '#2a2f3d',
  black: '#0f1115',
  red: '#e8863c',
  green: '#8bd17c',
  yellow: '#f0a84b',
  blue: '#6fa8ff',
  magenta: '#c792ea',
  cyan: '#7fdbca',
  white: '#e6e8ef',
  brightBlack: '#9aa1b2',
  brightRed: '#e8863c',
  brightGreen: '#8bd17c',
  brightYellow: '#f0a84b',
  brightBlue: '#6fa8ff',
  brightMagenta: '#c792ea',
  brightCyan: '#7fdbca',
  brightWhite: '#ffffff'
}

const HEADER_HEIGHT = 32

/** Collapsible terminal window docked under the main agent view, running the shell the user has
 *  selected in Settings. A single interactive PTY session persists across collapse/expand — it's
 *  only torn down when the workspace changes or the app closes. */
export function TerminalPanel() {
  const { workspace, terminalOpen, terminalHeight, toggleTerminal, setTerminalHeight } = useAppStore()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [shellName, setShellName] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const draggingRef = useRef(false)
  const startingRef = useRef(false)

  const startSession = async () => {
    if (!termRef.current || startingRef.current) return
    startingRef.current = true
    setExited(false)
    try {
      const { cols, rows } = termRef.current
      const { id, shellName: name } = await window.klenny.createTerminal(cols || 80, rows || 24)
      sessionIdRef.current = id
      setShellName(name)
    } finally {
      startingRef.current = false
    }
  }

  const disposeSession = () => {
    if (sessionIdRef.current) {
      void window.klenny.disposeTerminal(sessionIdRef.current)
      sessionIdRef.current = null
    }
  }

  // Mount xterm once.
  useEffect(() => {
    if (!containerRef.current || termRef.current) return
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      theme: XTERM_THEME,
      cursorBlink: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    term.onData((data) => {
      if (sessionIdRef.current) void window.klenny.writeTerminal(sessionIdRef.current, data)
    })
    termRef.current = term
    fitRef.current = fit

    const unsubData = window.klenny.onTerminalData((id, data) => {
      if (id === sessionIdRef.current) term.write(data)
    })
    const unsubExit = window.klenny.onTerminalExit((id) => {
      if (id === sessionIdRef.current) {
        sessionIdRef.current = null
        setExited(true)
      }
    })

    return () => {
      unsubData()
      unsubExit()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // (Re)create the PTY session whenever the workspace changes, as long as the panel has been
  // opened at least once — the shell's cwd is fixed at spawn time to the workspace root.
  useEffect(() => {
    if (!workspace) {
      disposeSession()
      termRef.current?.reset()
      setShellName(null)
      return
    }
    if (sessionIdRef.current) disposeSession()
    if (terminalOpen) void startSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace])

  // Lazily start the session the first time the panel is opened.
  useEffect(() => {
    if (terminalOpen && workspace && !sessionIdRef.current && !exited) {
      void startSession()
    }
  }, [terminalOpen, workspace])

  // Fit xterm to its container whenever the panel opens or is resized.
  useEffect(() => {
    if (!terminalOpen) return
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit()
      const term = termRef.current
      if (term && sessionIdRef.current) {
        void window.klenny.resizeTerminal(sessionIdRef.current, term.cols, term.rows)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [terminalOpen, terminalHeight])

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(() => {
      if (!terminalOpen) return
      fitRef.current?.fit()
      const term = termRef.current
      if (term && sessionIdRef.current) {
        void window.klenny.resizeTerminal(sessionIdRef.current, term.cols, term.rows)
      }
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [terminalOpen])

  useEffect(() => disposeSession, [])

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startY = e.clientY
    const startHeight = terminalHeight
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      setTerminalHeight(startHeight - (ev.clientY - startY))
    }
    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className="flex flex-col border-t border-klenny-border bg-klenny-panel shrink-0 overflow-hidden"
      style={{ height: terminalOpen ? terminalHeight : HEADER_HEIGHT }}
    >
      {terminalOpen && (
        <div
          className="h-1 cursor-row-resize hover:bg-klenny-accent/40 -mt-1"
          onMouseDown={onDragStart}
          title="Drag to resize"
        />
      )}
      <div
        className="h-8 flex items-center justify-between px-3 border-b border-klenny-border cursor-pointer select-none"
        onClick={() => toggleTerminal()}
      >
        <div className="flex items-center gap-2 text-xs text-klenny-muted">
          <span className={`transition-transform ${terminalOpen ? 'rotate-90' : ''}`}>▶</span>
          <span className="font-medium text-klenny-text">Terminal</span>
          {shellName && <span className="text-klenny-muted">— {shellName}</span>}
          {exited && <span className="text-klenny-accent2">(exited)</span>}
        </div>
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
          {exited && terminalOpen && (
            <button
              className="text-xs text-klenny-accent hover:underline"
              onClick={() => void startSession()}
              title="Start a new shell session"
            >
              Restart
            </button>
          )}
          {terminalOpen && !exited && (
            <button
              className="text-xs text-klenny-muted hover:text-klenny-accent"
              onClick={() => {
                disposeSession()
                setExited(true)
              }}
              title="Kill the current shell session"
            >
              Kill
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="absolute inset-0 p-1" />
        {!workspace && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-klenny-muted bg-klenny-panel">
            Open a project folder to use the terminal.
          </div>
        )}
      </div>
    </div>
  )
}
