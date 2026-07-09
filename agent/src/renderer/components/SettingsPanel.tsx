import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function SettingsPanel() {
  const { settings, models, setSettings, setModels } = useAppStore()
  const [apiKey, setApiKey] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    void window.klenny.listModels(true).then(setModels)
  }, [])

  if (!settings) return null
  const filtered = models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.id.includes(search))

  const patch = async (p: Partial<typeof settings>) => {
    const next = await window.klenny.setSettings(p)
    setSettings(next)
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl">
      <h2 className="text-xl font-semibold mb-4">Settings</h2>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">OpenRouter API key</h3>
        <input
          type="password"
          className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
          placeholder={settings.hasApiKey ? 'Key saved (enter to replace)' : 'sk-or-...'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            className="px-3 py-1 rounded bg-klenny-accent text-black text-sm"
            onClick={() => apiKey && void window.klenny.setApiKey(apiKey).then(() => window.klenny.getSettings().then(setSettings))}
          >
            Save key
          </button>
          <button className="px-3 py-1 rounded border border-klenny-border text-sm" onClick={() => void window.klenny.clearApiKey().then(() => window.klenny.getSettings().then(setSettings))}>
            Clear
          </button>
        </div>
      </section>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Models</h3>
        <input
          className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
          placeholder="Search models…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="block text-sm">Main model</label>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.mainModel} onChange={(e) => void patch({ mainModel: e.target.value })}>
          {filtered.map((m) => (
            <option key={m.id} value={m.id}>{m.pinned ? '★ ' : ''}{m.name}</option>
          ))}
        </select>
        <label className="block text-sm">Subagent model</label>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.subagentModel} onChange={(e) => void patch({ subagentModel: e.target.value })}>
          {filtered.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </section>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Approval mode</h3>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.approvalMode} onChange={(e) => void patch({ approvalMode: e.target.value as 'manual' | 'auto' })}>
          <option value="manual">Manual review (default)</option>
          <option value="auto">Auto-apply with checkpoints</option>
        </select>
      </section>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Spending cap (USD)</h3>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.spendingCapPeriod} onChange={(e) => void patch({ spendingCapPeriod: e.target.value as 'session' | 'daily' })}>
          <option value="session">Per session</option>
          <option value="daily">Per day</option>
        </select>
        <input
          type="number"
          min={0}
          step={0.5}
          className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
          placeholder="No cap"
          value={settings.spendingCapUsd ?? ''}
          onChange={(e) => void patch({ spendingCapUsd: e.target.value ? Number(e.target.value) : null })}
        />
      </section>

      <section className="space-y-2">
        <h3 className="font-medium">Theme</h3>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.theme} onChange={(e) => void patch({ theme: e.target.value as 'dark' | 'light' })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </section>
    </div>
  )
}
