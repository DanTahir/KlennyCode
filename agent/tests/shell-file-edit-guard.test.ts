import { describe, expect, test } from 'bun:test'
import './testElectronMock' // registers the shared electron mock before shell.ts's import of workspace.ts (which imports electron) loads anywhere

/**
 * Regression tests for run_command's "don't edit files via the shell" guard
 * (`fileEditGuardReason` in src/main/agent/tools/shell.ts).
 *
 * Every pattern used to be tested against the WHOLE command string, so a redirect belonging to one
 * segment got attributed to an `echo` in a completely different segment. Real read-only commands
 * were rejected with "Use edit_file or write_file to change files — not shell commands":
 *
 *   echo "--- ports ---"; netstat -ano | grep LISTENING; ls *.log 2>/dev/null || echo none
 *
 * The guard is a nudge toward edit_file/write_file (and their diff + approval flow), not a security
 * boundary — so the bar here is "don't block honest read-only work" while still catching the
 * genuine 'author file contents from the shell' patterns.
 */
describe('fileEditGuardReason', () => {
  const guard = async (command: string) => {
    const { fileEditGuardReason } = await import('../src/main/agent/tools/shell')
    return fileEditGuardReason(command)
  }

  describe('allows read-only / diagnostic commands (the reported false positives)', () => {
    // The exact command that was blocked in a real session.
    test('echo in one segment, unrelated 2>/dev/null in a later segment', async () => {
      expect(
        await guard('echo "--- ports ---"; netstat -ano | grep LISTENING; ls *.log 2>/dev/null || echo none')
      ).toBeNull()
    })

    test('echo with a stderr fd duplication', async () => {
      expect(await guard('echo "done" 2>&1')).toBeNull()
    })

    test('echo redirected to a null sink', async () => {
      expect(await guard('echo hi >/dev/null')).toBeNull()
      expect(await guard('echo hi > /dev/null 2>&1')).toBeNull()
    })

    test('build output piped through tee to a log file', async () => {
      expect(await guard('npm run build 2>&1 | tee build.log')).toBeNull()
      expect(await guard('curl -s https://example.com | tee /tmp/page.html')).toBeNull()
    })

    test('a > that only appears inside quotes', async () => {
      expect(await guard('echo "a > b"')).toBeNull()
      expect(await guard("echo 'redirect > here is literal'")).toBeNull()
    })

    test('echo as a search argument to another command that redirects', async () => {
      expect(await guard('grep echo file.txt > /tmp/matches.txt')).toBeNull()
    })

    test('sed without -i, followed by an unrelated -i flag in a later segment', async () => {
      expect(await guard("sed -n '1p' file.txt; grep -i pattern other.txt")).toBeNull()
    })

    test('sed without -i piped into a case-insensitive grep', async () => {
      expect(await guard("sed -n '1,20p' file.txt | grep -i error")).toBeNull()
    })

    test('assorted ordinary commands', async () => {
      expect(await guard('bun test')).toBeNull()
      expect(await guard('git log --oneline | head -20')).toBeNull()
      expect(await guard('ls -la > listing.txt')).toBeNull() // plain redirect, no authored content
      expect(await guard('echo "step 1 of 3" && bun test && echo "step 2"')).toBeNull()
    })
  })

  describe('still blocks authoring file contents from the shell', () => {
    test('echo redirected into a file', async () => {
      expect(await guard('echo "x" > file.txt')).toBe('echo/printf/heredoc content redirected into a file')
    })

    test('echo appended to a file', async () => {
      expect(await guard('echo "x" >> notes.md')).toBeTruthy()
      expect(await guard('printf "a\\nb\\n" >> notes.md')).toBeTruthy()
    })

    test('redirect with no spaces around it', async () => {
      expect(await guard('echo hi>f.txt')).toBeTruthy()
    })

    test('explicit stdout fd, and stdout+stderr, redirected to a file', async () => {
      expect(await guard('echo hi 1> f.txt')).toBeTruthy()
      expect(await guard('echo hi &> f.txt')).toBeTruthy()
    })

    test('echo reached via a path or behind an env assignment', async () => {
      expect(await guard('/bin/echo hi > f.txt')).toBeTruthy()
      expect(await guard('FOO=bar echo hi > f.txt')).toBeTruthy()
    })

    test('authored content piped into tee', async () => {
      expect(await guard('echo "content" | tee out.txt')).toBe('echo/printf/heredoc content piped into tee')
    })

    test('heredoc into a file', async () => {
      expect(await guard('cat <<EOF > config.json')).toBeTruthy()
      expect(await guard("cat <<'EOF' | tee config.json")).toBeTruthy()
    })

    test('a blocked statement anywhere in a chain is still caught', async () => {
      expect(await guard('bun test && echo "ok" > status.txt')).toBeTruthy()
      expect(await guard('ls -la\necho "ok" > status.txt')).toBeTruthy()
      expect(await guard('echo "a; b" > f.txt')).toBeTruthy() // separator inside quotes isn't a split
    })

    test('in-place stream editors', async () => {
      expect(await guard("sed -i 's/a/b/' file.txt")).toBe('sed -i in-place edit')
      expect(await guard("sed -i '' 's/a/b/' file.txt")).toBeTruthy()
      expect(await guard("perl -pi -e 's/a/b/' file.txt")).toBe('perl -pi in-place edit')
      expect(await guard("ed file.txt <<< 'x'")).toBeTruthy()
    })

    test('scripting-language file writes', async () => {
      expect(await guard(`node -e "require('fs').writeFileSync('a.txt','b')"`)).toBeTruthy()
      expect(await guard(`node -e "fs.createWriteStream('a.txt')"`)).toBeTruthy()
      expect(await guard(`python -c "open('a.txt','w').write('b')"`)).toBeTruthy()
      expect(await guard('powershell -Command "Set-Content a.txt b"')).toBeTruthy()
      expect(await guard('powershell -Command "\'b\' | Out-File a.txt"')).toBeTruthy()
    })
  })
})
