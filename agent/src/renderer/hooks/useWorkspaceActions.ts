import { useCallback } from 'react'
import { useAppStore } from '../store/useAppStore'

export function useWorkspaceActions() {
  const { setWorkspace, setTabs, setActiveTab, setSkills, setPlans, setModels } = useAppStore()

  const openWorkspace = useCallback(async () => {
    const path = await window.klenny.openWorkspace()
    setWorkspace(path)
    if (path) {
      const [tabs, skills, plans, models] = await Promise.all([
        window.klenny.listTabs(),
        window.klenny.listSkills().catch(() => []),
        window.klenny.listPlans().catch(() => []),
        window.klenny.listModels().catch(() => [])
      ])
      setTabs(tabs)
      if (tabs[0]) setActiveTab(tabs[0].id)
      setSkills(skills)
      setPlans(plans)
      setModels(models)
    }
    return path
  }, [setWorkspace, setTabs, setActiveTab, setSkills, setPlans, setModels])

  return { openWorkspace }
}
