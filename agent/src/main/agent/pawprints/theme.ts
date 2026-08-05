/**
 * Pawprint theme tokens — a small, fixed set of CSS-custom-property-style values every Pawprint
 * SDK exposes to its own renderer via `getTheme()`/`onThemeChange()`. Kept deliberately minimal
 * for v1; Pawprints render their own markup/CSS and only consume these as suggested values.
 */
export interface PawprintThemeTokens {
  background: string
  foreground: string
  accent: string
  fontFamily: string
  borderRadius: string
}

export const DEFAULT_PAWPRINT_THEME: PawprintThemeTokens = {
  background: '#1e1e1e',
  foreground: '#e8e8e8',
  accent: '#f5a623',
  fontFamily: 'system-ui, sans-serif',
  borderRadius: '8px'
}

/** Shallow-merges a per-Pawprint override on top of the current global theme. Unknown keys in
 *  the override are ignored (theme is a fixed, closed token set, not an open bag). */
export function mergePawprintTheme(
  base: PawprintThemeTokens,
  override: Partial<PawprintThemeTokens> | undefined | null
): PawprintThemeTokens {
  if (!override) return base
  const merged: PawprintThemeTokens = { ...base }
  for (const key of Object.keys(base) as (keyof PawprintThemeTokens)[]) {
    const v = override[key]
    if (typeof v === 'string' && v.length > 0) merged[key] = v
  }
  return merged
}
