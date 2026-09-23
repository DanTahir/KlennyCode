import { describe, expect, test } from 'bun:test'
import { extractMarkedValue, loginShellFor, mergePathLists, PATH_MARKER, resolveLoginShellPath } from '../src/main/loginShellPath'

const isWindows = process.platform === 'win32'

describe('extractMarkedValue', () => {
  test('extracts the value between markers, ignoring rc-file noise around it', () => {
    const out = `Welcome banner\n${PATH_MARKER}/opt/homebrew/bin:/usr/bin\n${PATH_MARKER}trailing junk`
    expect(extractMarkedValue(out)).toBe('/opt/homebrew/bin:/usr/bin')
  })
  test('returns null when the closing marker is missing (e.g. the probe timed out)', () => {
    expect(extractMarkedValue(`${PATH_MARKER}/usr/bin`)).toBeNull()
  })
  test('returns null for no markers or an empty value', () => {
    expect(extractMarkedValue('nothing here')).toBeNull()
    expect(extractMarkedValue(`${PATH_MARKER}\n${PATH_MARKER}`)).toBeNull()
  })
})

describe('mergePathLists', () => {
  test('login entries come first, inherited-only entries are appended, duplicates dropped', () => {
    expect(mergePathLists('/opt/homebrew/bin:/usr/bin:/bin', '/usr/bin:/bin:/usr/sbin:/sbin', ':')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    )
  })
  test('drops empty entries', () => {
    expect(mergePathLists('/a::/b', ':/c:', ':')).toBe('/a:/b:/c')
  })
})

describe('loginShellFor', () => {
  test('uses an absolute $SHELL', () => {
    expect(loginShellFor({ SHELL: '/opt/homebrew/bin/fish' }, 'darwin')).toBe('/opt/homebrew/bin/fish')
  })
  test('falls back per platform when $SHELL is unset or relative', () => {
    expect(loginShellFor({}, 'darwin')).toBe('/bin/zsh')
    expect(loginShellFor({ SHELL: 'zsh' }, 'linux')).toBe('/bin/sh')
  })
})

describe('resolveLoginShellPath (real shell)', () => {
  test.skipIf(isWindows)('reads a PATH from /bin/sh as a login + interactive shell', async () => {
    const path = await resolveLoginShellPath('/bin/sh')
    expect(path).not.toBeNull()
    expect(path!.split(':')).toContain('/usr/bin')
  })
  test.skipIf(isWindows)('resolves null, not a rejection, for a shell that does not exist', async () => {
    expect(await resolveLoginShellPath('/definitely/not/a/shell')).toBeNull()
  })
})
