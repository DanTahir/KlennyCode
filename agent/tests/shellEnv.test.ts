import { describe, expect, test, afterEach } from 'bun:test'

// Regression test for a real bug: pawprints/esbuildBinaryPath.ts sets
// process.env.ESBUILD_BINARY_PATH as a side effect on the running Electron main process the
// first time any Pawprint is bundled (needed so esbuild can find its own native binary once the
// app is packaged — see that file's doc comment for Bug #10). Both run_command's spawn() and the
// interactive terminal panel's pty.spawn() previously handed the spawned child the *entire*,
// unfiltered process.env — so that override leaked into every subsequent shell command and
// terminal tab, silently breaking any of the user's own tooling that has a different esbuild
// version expectation (observed in practice: `npm run dist:dir` failed with "Host version ...
// does not match binary version ..." because electron-vite's own bundled esbuild got redirected
// at the installed app's unrelated, differently-versioned unpacked esbuild binary).
describe('sanitizedSpawnEnv', () => {
  const ORIGINAL_ESBUILD_BINARY_PATH = process.env.ESBUILD_BINARY_PATH

  afterEach(() => {
    if (ORIGINAL_ESBUILD_BINARY_PATH === undefined) delete process.env.ESBUILD_BINARY_PATH
    else process.env.ESBUILD_BINARY_PATH = ORIGINAL_ESBUILD_BINARY_PATH
  })

  test('strips ESBUILD_BINARY_PATH from the env handed to a spawned shell/terminal', async () => {
    process.env.ESBUILD_BINARY_PATH = 'C:\\fake\\path\\to\\esbuild.exe'
    const { sanitizedSpawnEnv } = await import('../src/main/shellEnv')
    const env = sanitizedSpawnEnv()
    expect(env.ESBUILD_BINARY_PATH).toBeUndefined()
  })

  test('leaves other environment variables untouched', async () => {
    process.env.ESBUILD_BINARY_PATH = 'C:\\fake\\path\\to\\esbuild.exe'
    process.env.KLENNY_TEST_MARKER_VAR = 'still-here'
    const { sanitizedSpawnEnv } = await import('../src/main/shellEnv')
    const env = sanitizedSpawnEnv()
    expect(env.KLENNY_TEST_MARKER_VAR).toBe('still-here')
    delete process.env.KLENNY_TEST_MARKER_VAR
  })

  test('is a no-op copy when ESBUILD_BINARY_PATH was never set', async () => {
    delete process.env.ESBUILD_BINARY_PATH
    const { sanitizedSpawnEnv } = await import('../src/main/shellEnv')
    const env = sanitizedSpawnEnv()
    expect(env.ESBUILD_BINARY_PATH).toBeUndefined()
    // Sanity check it's still a real, populated env copy, not an accidentally-empty object.
    expect(Object.keys(env).length).toBeGreaterThan(0)
  })

  test('does not mutate process.env itself — only returns a filtered copy', async () => {
    process.env.ESBUILD_BINARY_PATH = 'C:\\fake\\path\\to\\esbuild.exe'
    const { sanitizedSpawnEnv } = await import('../src/main/shellEnv')
    sanitizedSpawnEnv()
    expect(process.env.ESBUILD_BINARY_PATH).toBe('C:\\fake\\path\\to\\esbuild.exe')
  })
})
