import { describe, expect, test } from 'bun:test'
import { mergePawprintTheme, DEFAULT_PAWPRINT_THEME, type PawprintThemeTokens } from '../src/main/agent/pawprints/theme'

describe('mergePawprintTheme', () => {
  test('returns the base unchanged when override is undefined', () => {
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, undefined)
    expect(result).toEqual(DEFAULT_PAWPRINT_THEME)
  })

  test('returns the base unchanged when override is null', () => {
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, null)
    expect(result).toEqual(DEFAULT_PAWPRINT_THEME)
  })

  test('returns the base unchanged when override is an empty object', () => {
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, {})
    expect(result).toEqual(DEFAULT_PAWPRINT_THEME)
  })

  test('overrides a single known key while leaving others at base values', () => {
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, { accent: '#ff0000' })
    expect(result.accent).toBe('#ff0000')
    expect(result.background).toBe(DEFAULT_PAWPRINT_THEME.background)
    expect(result.foreground).toBe(DEFAULT_PAWPRINT_THEME.foreground)
    expect(result.fontFamily).toBe(DEFAULT_PAWPRINT_THEME.fontFamily)
    expect(result.borderRadius).toBe(DEFAULT_PAWPRINT_THEME.borderRadius)
  })

  test('overrides multiple keys at once', () => {
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, { background: '#ffffff', foreground: '#000000' })
    expect(result.background).toBe('#ffffff')
    expect(result.foreground).toBe('#000000')
  })

  test('ignores an override value that is an empty string (falls back to base)', () => {
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, { accent: '' })
    expect(result.accent).toBe(DEFAULT_PAWPRINT_THEME.accent)
  })

  test('ignores a non-string override value for a known key', () => {
    const override = { accent: 42 } as unknown as Partial<PawprintThemeTokens>
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, override)
    expect(result.accent).toBe(DEFAULT_PAWPRINT_THEME.accent)
  })

  test('does not mutate the base theme object passed in', () => {
    const baseCopy = { ...DEFAULT_PAWPRINT_THEME }
    mergePawprintTheme(DEFAULT_PAWPRINT_THEME, { accent: '#123456' })
    expect(DEFAULT_PAWPRINT_THEME).toEqual(baseCopy)
  })

  test('an unknown key in the override is silently ignored (closed token set)', () => {
    const override = { notARealToken: 'value' } as unknown as Partial<PawprintThemeTokens>
    const result = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, override)
    expect(result).toEqual(DEFAULT_PAWPRINT_THEME)
    expect((result as Record<string, unknown>).notARealToken).toBeUndefined()
  })

  test('merging on top of a non-default base theme still works (global override then per-Pawprint override)', () => {
    const globalOverride = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, { background: '#010203' })
    const perPawprint = mergePawprintTheme(globalOverride, { accent: '#a1b2c3' })
    expect(perPawprint.background).toBe('#010203') // inherited from the global override layer
    expect(perPawprint.accent).toBe('#a1b2c3') // overridden at the per-Pawprint layer
  })
})
