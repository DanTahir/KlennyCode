import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Sidebar "Open Assistant" button action — always creates a brand-new Assistant tab (no
 *  create-or-focus singleton behavior; see the Personal Assistant Platform plan). Assistant
 *  tabs persist across app restarts and, once closed (with messages), are archived to the
 *  "Assistant" section of the History panel rather than being discarded. */
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
