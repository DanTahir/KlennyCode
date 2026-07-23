import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Sidebar "Open Assistant" button action — always creates a brand-new, ephemeral Assistant
 *  tab (no create-or-focus singleton behavior in v1; see the Personal Assistant Platform plan).
 *  Closing it later simply discards it, since createAssistantTab() never persists to disk. */
export function useAssistantTabActions() {
  const { setTabs, setActiveTab, setPanel } = useAppStore()

  const openAssistantTab = useCallback(async () => {
    const tab = await window.klenny.createAssistantTab()
    setTabs(await window.klenny.listTabs())
    setActiveTab(tab.id)
    setPanel('chat')
    return tab
  }, [setTabs, setActiveTab, setPanel])

  return { openAssistantTab }
}
