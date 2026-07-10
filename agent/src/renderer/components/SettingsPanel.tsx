import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function SettingsPanel() {
  const { settings, models, shells, setSettings, setModels, setShells } = useAppStore()
  const [apiKey, setApiKey] = useState('')
  const [search, setSearch] = useState('')
  const [providerOnly, setProviderOnly] = useState('')
  const [providerOrder, setProviderOrder] = useState('')
  const [showAdvancedProvider, setShowAdvancedProvider] = useState(false)

  useEffect(() => {
    void window.klenny.listModels(true).then(setModels)
    void window.klenny.listShells().then(setShells)
  }, [])

  useEffect(() => {
    if (!settings?.providerPreference) return
    setProviderOnly((settings.providerPreference.only ?? []).join(', '))
    setProviderOrder((settings.providerPreference.order ?? []).join(', '))
  }, [settings?.providerPreference])

  if (!settings) return null
  const filtered = models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.id.includes(search))

  const patch = async (p: Partial<typeof settings>) => {
    const next = await window.klenny.setSettings(p)
    setSettings(next)
  }

  const parseCsv = (s: string): string[] | undefined => {
    const parts = s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    return parts.length ? parts : undefined
  }

  const applyProviderPreference = async () => {
    const only = parseCsv(providerOnly)
    const order = parseCsv(providerOrder)
    await patch({ providerPreference: only || order ? { only, order } : undefined })
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
            <option key={m.id} value={m.id}>
              {m.pinned ? '★ ' : ''}
              {m.cacheReadPrice != null ? '⚡ ' : ''}
              {m.name}
            </option>
          ))}
        </select>
        <label className="block text-sm">Subagent model</label>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.subagentModel} onChange={(e) => void patch({ subagentModel: e.target.value })}>
          {filtered.map((m) => (
            <option key={m.id} value={m.id}>
              {m.cacheReadPrice != null ? '⚡ ' : ''}
              {m.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-klenny-muted">⚡ marks models that support OpenRouter prompt caching.</p>
      </section>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Prompt caching</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.promptCachingEnabled}
            onChange={(e) => void patch({ promptCachingEnabled: e.target.checked })}
          />
          Cache repeated context to cut costs
        </label>
        <p className="text-xs text-klenny-muted">
          Automatically caches repeated context (system prompt, tool definitions, conversation history) on models
          that support it (Anthropic, OpenAI, Gemini, DeepSeek, and more) to cut costs. Has no effect on models
          without caching support.
        </p>
        <button
          className="text-xs text-klenny-accent underline"
          onClick={() => setShowAdvancedProvider((v) => !v)}
        >
          {showAdvancedProvider ? 'Hide' : 'Show'} advanced: provider preference
        </button>
        {showAdvancedProvider && (
          <div className="space-y-2 border border-klenny-border rounded p-3">
            <p className="text-xs text-klenny-muted">
              Optional. Force requests to specific OpenRouter providers (comma-separated slugs, e.g. "anthropic").
              "Only" still allows fallback and keeps cache-warm sticky routing; "Order" disables OpenRouter's
              sticky routing / load balancing, so prefer "Only" unless you need strict ordering.
            </p>
            <label className="block text-sm">Only allow providers</label>
            <input
              className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
              placeholder="e.g. anthropic"
              value={providerOnly}
              onChange={(e) => setProviderOnly(e.target.value)}
              onBlur={() => void applyProviderPreference()}
            />
            <label className="block text-sm">Explicit provider order (advanced)</label>
            <input
              className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
              placeholder="e.g. anthropic, google-vertex"
              value={providerOrder}
              onChange={(e) => setProviderOrder(e.target.value)}
              onBlur={() => void applyProviderPreference()}
            />
          </div>
        )}
      </section>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Shell</h3>
        <select
          className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
          value={settings.shellId ?? ''}
          onChange={(e) => void patch({ shellId: e.target.value || null })}
        >
          <option value="">Auto (system default)</option>
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-klenny-muted">
          Shell used to run commands (build, test, git, etc.). Detected from your system — pick Git Bash, PowerShell,
          WSL, or another installed shell.
        </p>
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
