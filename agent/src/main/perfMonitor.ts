/**
 * Main-process event-loop stall monitor.
 *
 * Electron's main process also drives IPC to the renderer, so any long synchronous task there
 * (a huge JSON.stringify, a sync file write, a blocking native call) freezes the whole UI. This
 * timer checks how late it fired; a large delay means the loop was blocked for about that long.
 * The `[perf]` lines land in the app's own log (processLog.ts), so `read_app_log` with filter
 * `[perf]` shows when freezes happened, correlated with the surrounding `[codeindex]`/`[session]`
 * lines.
 */
const TICK_MS = 250
/** Delays above this are reported. Below it, normal GC pauses and scheduling jitter dominate. */
const REPORT_THRESHOLD_MS = 300

let timer: NodeJS.Timeout | null = null

export function startEventLoopStallMonitor(): void {
  if (timer) return
  let expected = Date.now() + TICK_MS
  timer = setInterval(() => {
    const now = Date.now()
    const lag = now - expected
    expected = now + TICK_MS
    if (lag >= REPORT_THRESHOLD_MS) {
      console.warn(`[perf] main event loop blocked ~${lag}ms (ended ${new Date(now).toISOString()})`)
    }
  }, TICK_MS)
  // Never keep the process alive just for monitoring.
  timer.unref()
}

export function stopEventLoopStallMonitor(): void {
  if (timer) clearInterval(timer)
  timer = null
}
