/** Formats a `ChatMessage.createdAt` epoch into the fixed "HH:MM AM/PM, MM/DD/YYYY" form shown
 *  at the bottom of every message bubble (see MessageBubble.tsx).
 *
 *  Deliberately hand-formatted rather than `toLocaleString()`: the shape is a product decision
 *  (12-hour clock, zero-padded hour, US-style numeric date), so it must not drift with the host
 *  machine's locale — an en-GB box would otherwise render DD/MM/YYYY on a 24-hour clock. The
 *  *timezone* still follows the machine, which is the intent: the user sees their own local time.
 *
 *  Returns '' for a missing/NaN/non-finite epoch so callers render nothing instead of
 *  "Invalid Date" — archived sessions written before `createdAt` existed can lack the field, and
 *  a persisted session is JSON, so nothing structurally guarantees it is a number at read time. */
export function formatMessageTimestamp(epochMs: number | null | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return ''
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return ''

  const pad = (n: number) => String(n).padStart(2, '0')
  const hours24 = d.getHours()
  const period = hours24 < 12 ? 'AM' : 'PM'
  // 0 -> 12 AM, 12 -> 12 PM; every other hour is hours24 % 12.
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12

  return `${pad(hours12)}:${pad(d.getMinutes())} ${period}, ${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`
}
