import { describe, expect, test } from 'bun:test'
import './testElectronMock' // registers a shared electron mock — see that file for why this matters; loop.ts transitively imports electron (BrowserWindow/Notification) via branding.ts/settings.ts et al., so it must be loaded dynamically below, after this mock is registered

// Regression test: save_plan's `checklist` arg and update_checklist's `updates` arg both go
// through this helper. Some models double-encode nested-array tool arguments as a JSON string
// instead of sending a real array (see repo gotchas) — previously that silently produced an
// empty checklist with no error surfaced anywhere, which is why "Approve" would show no
// checklist widget at all even though the plan text itself came through fine.
describe('coerceArrayArg', () => {
  test('passes a real array through unchanged', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    expect(coerceArrayArg(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('parses a JSON-encoded array string into a real array', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    expect(coerceArrayArg('["a","b","c"]')).toEqual(['a', 'b', 'c'])
  })

  test('parses a JSON-encoded array of objects (update_checklist shape)', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    const raw = JSON.stringify([{ index: 1, done: true }, { index: 2, done: false }])
    expect(coerceArrayArg(raw)).toEqual([{ index: 1, done: true }, { index: 2, done: false }])
  })

  test('returns [] for a string that is not valid JSON', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    expect(coerceArrayArg('not json')).toEqual([])
  })

  test('returns [] for a JSON string that parses but not to an array', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    expect(coerceArrayArg('{"a":1}')).toEqual([])
  })

  test('returns [] for undefined/missing', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    expect(coerceArrayArg(undefined)).toEqual([])
  })

  test('returns [] for a non-array, non-string value', async () => {
    const { coerceArrayArg } = await import('../src/main/agent/orchestrator/loop')
    expect(coerceArrayArg(42)).toEqual([])
    expect(coerceArrayArg({ foo: 'bar' })).toEqual([])
  })
})
