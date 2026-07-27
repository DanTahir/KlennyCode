import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'

/** "Open Code Chat" action (sidebar button + tab bar plus button) — creates a brand-new
 *  code/project chat tab (tab.kind !== 'assistant'), mirroring useAssistantTabActions. */
export function useCodeTabActions() {
  const { setTabs, setActiveTab, setPanel } = useAppStore()

  const openCodeTab = useCallback(async () => {
    const tab = await window.klenny.createTab()
    setTabs(await window.klenny.listTabs())
    setActiveTab(tab.id)
    setPanel('chat')
    return tab
  }, [setTabs, setActiveTab, setPanel])

  return { openCodeTab }
}
