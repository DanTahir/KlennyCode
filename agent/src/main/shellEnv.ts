/**
 * Environment sanitization for any process spawned on the user's behalf (run_command's
 * subprocess in tools/shell.ts, and the interactive terminal panel's PTY in terminal.ts).
 *
 * Bug: `pawprints/esbuildBinaryPath.ts` sets `process.env.ESBUILD_BINARY_PATH` as a side effect
 * on the running Electron main process the first time any Pawprint gets bundled (create_pawprint/
 * update_pawprint) — necessary so esbuild can find its own native binary once *this app* is
 * packaged (see that file's doc comment for Bug #10). That's correct and load-bearing for
 * bundlePawprint() itself, which reads it in-process and never spawns a shell.
 *
 * But both run_command and the terminal panel previously handed the spawned child the *entire*
 * `process.env` of that same main process, unfiltered — so once a user built a Pawprint in a
 * session, that env var leaked into every subsequent `run_command` call and every terminal tab,
 * silently overriding whatever esbuild version *that* spawned process's own toolchain expected.
 * Confirmed in practice: it broke `npm run dist:dir` (electron-vite's bundled esbuild 0.21.x
 * refused to talk to the installed app's unpacked esbuild binary, a different version) with
 * "Host version ... does not match binary version ...".
 *
 * Fix: strip this (and any future main-process-only override added here) from the env object
 * handed to spawn()/pty.spawn() for user-facing shells, so our own packaged-app workaround can
 * never leak into and corrupt the user's own build/dev tooling.
 */
const MAIN_PROCESS_ONLY_ENV_VARS = ['ESBUILD_BINARY_PATH'] as const

/** Returns a shallow copy of `process.env` with the main-process-only overrides above removed —
 *  safe to pass directly as the `env` option to `child_process.spawn()` or `pty.spawn()`. */
export function sanitizedSpawnEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  for (const key of MAIN_PROCESS_ONLY_ENV_VARS) delete env[key]
  return env
}
