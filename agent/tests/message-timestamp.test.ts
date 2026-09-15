import { describe, expect, test } from 'bun:test'
import { formatMessageTimestamp } from '../shared/time'

// Every Date here is built from LOCAL components and asserted against local components, so these
// tests are timezone-independent (they'd otherwise pass only on the machine that wrote them).
describe('formatMessageTimestamp', () => {
  test('renders the exact HH:MM AM/PM, MM/DD/YYYY shape with zero padding', () => {
    const d = new Date(2026, 8, 15, 11, 25) // Sep 15 2026, 11:25 local
    expect(formatMessageTimestamp(d.getTime())).toBe('11:25 AM, 09/15/2026')
  })

  test('zero-pads a single-digit hour, minute, month and day', () => {
    const d = new Date(2026, 0, 5, 9, 7)
    expect(formatMessageTimestamp(d.getTime())).toBe('09:07 AM, 01/05/2026')
  })

  test('midnight is 12 AM, not 00 AM', () => {
    const d = new Date(2026, 0, 5, 0, 3)
    expect(formatMessageTimestamp(d.getTime())).toBe('12:03 AM, 01/05/2026')
  })

  test('noon is 12 PM, not 00 PM', () => {
    const d = new Date(2026, 0, 5, 12, 0)
    expect(formatMessageTimestamp(d.getTime())).toBe('12:00 PM, 01/05/2026')
  })

  test('afternoon hours convert to the 12-hour clock', () => {
    const d = new Date(2026, 11, 31, 23, 59)
    expect(formatMessageTimestamp(d.getTime())).toBe('11:59 PM, 12/31/2026')
  })

  // A legacy/archived message with no usable createdAt must render as nothing, never as
  // "Invalid Date" / "NaN:NaN" in the UI.
  test('returns empty string for missing or unusable input', () => {
    expect(formatMessageTimestamp(undefined)).toBe('')
    expect(formatMessageTimestamp(null)).toBe('')
    expect(formatMessageTimestamp(Number.NaN)).toBe('')
    expect(formatMessageTimestamp(Number.POSITIVE_INFINITY)).toBe('')
    expect(formatMessageTimestamp('nope' as unknown as number)).toBe('')
  })
})
