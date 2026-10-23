import type { ModelWaitingInfo } from './types'

/** "45s" / "2m 05s". */
export function formatWaitDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const RETRY_CAUSE: Record<NonNullable<ModelWaitingInfo['retryReason']>, string> = {
  stall: 'the previous attempt stalled',
  deadline: 'the previous attempt hit the per-request time limit',
  network: 'the previous attempt lost its connection',
  http: 'the provider returned a temporary error'
}

/** One-line status, e.g. "Waiting on the model — 1m 05s with no output yet". */
export function describeModelWaiting(info: ModelWaitingInfo): string {
  const what = info.phase === 'first-token' ? 'with no output yet' : 'since its last output'
  return `Waiting on the model — ${formatWaitDuration(info.silentMs)} ${what}`
}

/** Explanatory follow-up for the status line: retry context, liveness, and what happens next. */
export function modelWaitingDetail(info: ModelWaitingInfo): string {
  const parts: string[] = []
  if (info.retryReason) {
    parts.push(`Retrying because ${RETRY_CAUSE[info.retryReason]} (attempt ${info.attempt} of ${info.maxAttempts}).`)
  }
  parts.push(
    info.keepAlives > 0
      ? `The connection is alive (${info.keepAlives} keep-alive${info.keepAlives === 1 ? '' : 's'} from OpenRouter), but nothing new has been generated.`
      : 'Nothing has arrived from the provider yet.'
  )
  const left = formatWaitDuration(Math.max(0, info.stallAfterMs - info.silentMs))
  parts.push(
    info.phase === 'first-token' && info.attempt >= info.maxAttempts
      ? `This is the last attempt: if nothing arrives within ${left}, the turn stops with an error.`
      : `If nothing arrives within ${left}, the request is cancelled and retried automatically.`
  )
  return parts.join(' ')
}
