/**
 * Source of the `klenny-pawprint-sdk` virtual module — the only "import from the host app" a
 * Pawprint's generated source is allowed to use. Injected at bundle time by an esbuild plugin
 * (see bundler.ts) rather than resolved from node_modules; there is no real package on disk
 * with this name. Talks to the main process exclusively through the narrow context-bridge API
 * exposed by the dedicated Pawprint preload script (preloadPawprint.ts) — never Node/Electron
 * APIs directly, since the renderer has nodeIntegration:false/contextIsolation:true/sandbox:true.
 */
export const PAWPRINT_SDK_SOURCE = `
const bridge = window.__pawprintBridge

export function getState() {
  return bridge.getState()
}

export function setState(next) {
  return bridge.setState(next)
}

export function getTheme() {
  return bridge.getTheme()
}

export function onThemeChange(cb) {
  return bridge.onThemeChange(cb)
}

export function closeWindow() {
  return bridge.close()
}

export function requestNewInstance(label) {
  return bridge.requestNewInstance(label)
}

export function deleteSelf() {
  return bridge.deleteSelf()
}
`
