import { describe, expect, test } from 'bun:test'
import './testElectronMock' // registers a shared electron mock — see that file for why this matters

const { ApprovalManager } = await import('../src/main/agent/approval/manager')

describe('ApprovalManager accept-all scoping', () => {
  test('accept_all only auto-accepts future actions on the same tab', async () => {
    const mgr = new ApprovalManager()

    const actionA1 = mgr.buildPendingFromTool('tabA', 'tc1', 'write_file', 'write a.txt', {})
    const actionB1 = mgr.buildPendingFromTool('tabB', 'tc2', 'write_file', 'write b.txt', {})

    // User accepts-all on tab A's first action.
    const waitA1 = mgr.waitForDecision(actionA1.id)
    mgr.resolve(actionA1.id, 'accept_all')
    expect(await waitA1).toBe('accept')

    // A later action on tab A should auto-accept without needing resolve().
    const actionA2 = mgr.buildPendingFromTool('tabA', 'tc3', 'edit_file', 'edit a.txt', {})
    expect(await mgr.waitForDecision(actionA2.id)).toBe('accept')

    // Tab B's pending action should NOT be auto-accepted — it must still wait.
    let resolvedB = false
    const waitB1 = mgr.waitForDecision(actionB1.id).then((d) => {
      resolvedB = true
      return d
    })
    await Promise.resolve() // flush microtasks
    expect(resolvedB).toBe(false)

    mgr.resolve(actionB1.id, 'reject')
    expect(await waitB1).toBe('reject')

    // And a new action on tab B still isn't auto-accepted.
    const actionB2 = mgr.buildPendingFromTool('tabB', 'tc4', 'write_file', 'write b2.txt', {})
    let resolvedB2 = false
    const waitB2 = mgr.waitForDecision(actionB2.id).then((d) => {
      resolvedB2 = true
      return d
    })
    await Promise.resolve()
    expect(resolvedB2).toBe(false)
    mgr.resolve(actionB2.id, 'accept')
    expect(await waitB2).toBe('accept')
  })

  test('setMode("manual") clears accept-all state for all tabs', async () => {
    const mgr = new ApprovalManager()
    const action1 = mgr.buildPendingFromTool('tabA', 'tc1', 'write_file', 'write a.txt', {})
    mgr.resolve(action1.id, 'accept_all')

    mgr.setMode('manual')

    const action2 = mgr.buildPendingFromTool('tabA', 'tc2', 'write_file', 'write a2.txt', {})
    let resolved = false
    const wait2 = mgr.waitForDecision(action2.id).then((d) => {
      resolved = true
      return d
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    mgr.resolve(action2.id, 'accept')
    expect(await wait2).toBe('accept')
  })

  test('clearTab removes accept-all state for that tab only', async () => {
    const mgr = new ApprovalManager()
    const actionA1 = mgr.buildPendingFromTool('tabA', 'tc1', 'write_file', 'write a.txt', {})
    mgr.resolve(actionA1.id, 'accept_all')

    mgr.clearTab('tabA')

    const actionA2 = mgr.buildPendingFromTool('tabA', 'tc2', 'write_file', 'write a2.txt', {})
    let resolved = false
    const wait2 = mgr.waitForDecision(actionA2.id).then((d) => {
      resolved = true
      return d
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    mgr.resolve(actionA2.id, 'accept')
    expect(await wait2).toBe('accept')
  })
})
