/**
 * Allows CSS custom properties (`--foo`) in React `style` objects.
 *
 * WHY THIS EXISTS
 * ---------------
 * Many sites set theme values as inline CSS variables, e.g.
 *
 *     <header style="--logo-color:defaultFilled;--button-theme:blackFilled">
 *     <a style="--button-background-color:#00E013;--button-text-color:#000000">
 *
 * Codegen faithfully reproduces those as `style={{ "--logo-color": "..." }}`.
 * React supports this at runtime — unknown `--*` keys are handed to
 * `CSSStyleDeclaration.setProperty` — but csstype's `Properties` interface has
 * no index signature, so a plain object literal is rejected at compile time:
 *
 *     error TS2353: Object literal may only specify known properties,
 *     and '"--logo-color"' does not exist in type 'Properties<string | number>'.
 *
 * Augmenting `csstype` is the maintained, documented escape hatch for this (it
 * is what csstype's own README recommends), and it is strictly additive: it only
 * widens the accepted key set, so genuine typos in *real* CSS property names are
 * still caught. The alternative — casting every generated `style` prop to
 * `React.CSSProperties` — would silence real errors across the whole component.
 *
 * This file is part of the template and needs no per-site editing.
 */

declare module 'csstype' {
  interface Properties {
    // Any CSS custom property. The value type matches what csstype already
    // allows for standard properties.
    [customProperty: `--${string}`]: string | number | undefined;
  }
}

export {};
