import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store/useAppStore'

/** "Open Code Chat" action (sidebar button + tab bar plus button) — creates a brand-new
 *  code/project chat tab (tab.kind !== 'assistant'), mirroring useAssistantTabActions. */
export function useCodeTabActions() {
  const { setTabs, setActiveTab, setPanel } = useAppStore(
    useShallow((s) => ({ setTabs: s.setTabs, setActiveTab: s.setActiveTab, setPanel: s.setPanel }))
  )

  const openCodeTab = useCallback(async () => {
    const tab = await window.klenny.createTab()
    setTabs(await window.klenny.listTabs())
    setActiveTab(tab.id)
    setPanel('chat')
    return tab
  }, [setTabs, setActiveTab, setPanel])

  return { openCodeTab }
}
