/**
 * Minimal pub/sub so the "My Pawprints" panel can be told to refresh whenever the underlying
 * registry/manifest data actually changes, no matter which code path caused the change: the
 * panel's own buttons (openPawprint/deletePawprintInstance/etc IPC handlers below), an in-app
 * control inside a Pawprint's own sandboxed window (requestNewInstance/deleteSelf via
 * preloadPawprint.ts's bridge), or reopenAllOnLaunch() at startup. Without this, the panel only
 * ever refreshed after its OWN button clicks (see withBusy() in PawprintsPanel.tsx) — a new
 * instance opened from inside a Pawprint's own UI silently changed the registry on disk but
 * never told the already-mounted panel component to re-fetch, so it stayed stale until some
 * unrelated refresh (e.g. clicking another button) happened to reread the list.
 */

type Listener = () => void

const listeners = new Set<Listener>()

export function onPawprintsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitPawprintsChanged(): void {
  for (const listener of listeners) listener()
}
