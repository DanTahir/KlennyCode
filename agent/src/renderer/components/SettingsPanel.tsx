import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { DEFAULT_EMBEDDINGS_MODEL } from '@shared/types'

export function SettingsPanel() {
  const { settings, models, shells, indexStatus, setSettings, setModels, setShells, setIndexStatus } = useAppStore()
  const [apiKey, setApiKey] = useState('')
  const [search, setSearch] = useState('')
  const [providerOnly, setProviderOnly] = useState('')
  const [providerOrder, setProviderOrder] = useState('')
  const [showAdvancedProvider, setShowAdvancedProvider] = useState(false)
  const [pineconeKey, setPineconeKey] = useState('')

  useEffect(() => {
    void window.klenny.listModels(true).then(setModels)
    void window.klenny.listShells().then(setShells)
    void window.klenny.getIndexStatus().then(setIndexStatus)
  }, [])

  useEffect(() => {
    if (!settings?.providerPreference) return
    setProviderOnly((settings.providerPreference.only ?? []).join(', '))
    setProviderOrder((settings.providerPreference.order ?? []).join(', '))
  }, [settings?.providerPreference])

  // Pre-fill the recommended embeddings model the first time the feature is enabled and a
  // model list is available — a convenience default, not a silent fallback if the catalog
  // ever changes (the picker always shows exactly what's actually selected in settings).
  useEffect(() => {
    if (!settings?.codebaseIndexEnabled || settings.embeddingsModel || models.length === 0) return
    const hasDefault = models.some((m) => m.id === DEFAULT_EMBEDDINGS_MODEL && m.supportsEmbeddings)
    if (hasDefault) void patch({ embeddingsModel: DEFAULT_EMBEDDINGS_MODEL })
  }, [settings?.codebaseIndexEnabled, settings?.embeddingsModel, models])

  if (!settings) return null
  const filtered = models.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()) || m.id.includes(search))
  const embeddingModels = models.filter((m) => m.supportsEmbeddings)

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
            onClick={() =>
              apiKey &&
              void window.klenny
                .setApiKey(apiKey)
                .then(() => window.klenny.getSettings())
                .then((s) => {
                  setSettings(s)
                  setApiKey('')
                  return window.klenny.listModels(true)
                })
                .then(setModels)
            }
          >
            Save key
          </button>
          <button
            className="px-3 py-1 rounded border border-klenny-border text-sm"
            onClick={() =>
              void window.klenny
                .clearApiKey()
                .then(() => window.klenny.getSettings())
                .then((s) => {
                  setSettings(s)
                  setApiKey('')
                  return window.klenny.listModels(true)
                })
                .then(setModels)
            }
          >
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
        <label className="block text-sm">Utility model (housekeeping, e.g. summarization)</label>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.utilityModel} onChange={(e) => void patch({ utilityModel: e.target.value })}>
          {filtered.map((m) => (
            <option key={m.id} value={m.id}>
              {m.cacheReadPrice != null ? '⚡ ' : ''}
              {m.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-klenny-muted">
          Used for internal tasks like compacting old conversation history. Pick something fast and cheap — quality
          here doesn't affect your main answers.
        </p>
        <p className="text-xs text-klenny-muted">⚡ marks models that support OpenRouter prompt caching.</p>
        <button
          className="px-3 py-1 rounded border border-klenny-border text-sm"
          onClick={() => useAppStore.getState().setPanel('cost-report')}
        >
          Cost Report
        </button>
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
        <h3 className="font-medium">Codebase semantic search <span className="text-xs text-klenny-muted">(beta)</span></h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.codebaseIndexEnabled}
            onChange={(e) => void patch({ codebaseIndexEnabled: e.target.checked })}
          />
          Enable semantic code search
        </label>
        <p className="text-xs text-klenny-muted">
          Lets the agent find relevant code by meaning, not just exact text — like Cursor's codebase search.
          Indexes your workspace in the background and stays live-updated while you work. Uses your existing
          OpenRouter key for embeddings — no extra signup — but does spend a small amount of credits per file
          indexed and per search.
        </p>
        {settings.codebaseIndexEnabled && (
          <div className="space-y-2 border border-klenny-border rounded p-3">
            <label className="block text-sm">Embeddings model</label>
            <select
              className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
              value={settings.embeddingsModel ?? ''}
              onChange={(e) => void patch({ embeddingsModel: e.target.value || null })}
            >
              <option value="">Select a model…</option>
              {embeddingModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === DEFAULT_EMBEDDINGS_MODEL ? '★ ' : ''}
                  {m.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-klenny-muted">★ recommended — tuned for text and code retrieval.</p>

            <label className="block text-sm">Vector store</label>
            <select
              className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
              value={settings.vectorStoreBackend}
              onChange={(e) => void patch({ vectorStoreBackend: e.target.value as 'local' | 'pinecone' })}
            >
              <option value="local">Local (default, no signup)</option>
              <option value="pinecone">Pinecone (cloud)</option>
            </select>

            {settings.vectorStoreBackend === 'pinecone' && (
              <div className="space-y-2 border border-klenny-border rounded p-3">
                <input
                  type="password"
                  className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                  placeholder={settings.hasPineconeKey ? 'Pinecone key saved (enter to replace)' : 'Pinecone API key'}
                  value={pineconeKey}
                  onChange={(e) => setPineconeKey(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    className="px-3 py-1 rounded bg-klenny-accent text-black text-sm"
                    onClick={() =>
                      pineconeKey &&
                      void window.klenny
                        .setPineconeKey(pineconeKey)
                        .then(() => window.klenny.getSettings())
                        .then((s) => {
                          setSettings(s)
                          setPineconeKey('')
                        })
                    }
                  >
                    Save key
                  </button>
                  <button
                    className="px-3 py-1 rounded border border-klenny-border text-sm"
                    onClick={() =>
                      void window.klenny
                        .clearPineconeKey()
                        .then(() => window.klenny.getSettings())
                        .then((s) => {
                          setSettings(s)
                          setPineconeKey('')
                        })
                    }
                  >
                    Clear
                  </button>
                </div>
                <label className="block text-sm">Pinecone index name</label>
                <input
                  className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                  placeholder="e.g. klenny-code"
                  value={settings.pineconeIndexName ?? ''}
                  onChange={(e) => void patch({ pineconeIndexName: e.target.value || null })}
                />
                <p className="text-xs text-klenny-muted">
                  Data stored in Pinecone must be managed in Pinecone's own console — "Delete index" below only
                  affects the local index, never a connected Pinecone index.
                </p>
              </div>
            )}

            <p className="text-xs text-klenny-muted">
              Status:{' '}
              {indexStatus?.phase === 'error'
                ? `Error — ${indexStatus.message ?? 'unknown error'}`
                : indexStatus?.phase === 'scanning'
                  ? indexStatus.message ?? 'Scanning workspace…'
                  : indexStatus?.phase === 'embedding'
                    ? `Indexing ${indexStatus.filesDone ?? 0}/${indexStatus.filesTotal ?? 0} files…`
                    : indexStatus?.lastUpdatedAt
                      ? `Index ready (${indexStatus.filesTotal ?? 0} files, updated ${new Date(indexStatus.lastUpdatedAt).toLocaleTimeString()})`
                      : 'Not yet indexed'}
            </p>
            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded border border-klenny-border text-sm"
                onClick={() => void window.klenny.rebuildIndex()}
              >
                Rebuild index
              </button>
              <button
                className="px-3 py-1 rounded border border-klenny-border text-sm"
                onClick={() => void window.klenny.deleteIndex().then(() => window.klenny.getIndexStatus()).then(setIndexStatus)}
              >
                Delete index
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Long-running tasks</h3>
        <select
          className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
          value={settings.continueMode}
          onChange={(e) => void patch({ continueMode: e.target.value as 'auto' | 'checkpoint' })}
        >
          <option value="auto">Auto-continue (default) — keep working until the task is done</option>
          <option value="checkpoint">Checkpoint — pause every N steps for a manual Continue click</option>
        </select>
        <p className="text-xs text-klenny-muted">
          Controls how long the agent is allowed to keep calling tools in a single turn before stopping. "Auto-continue"
          pushes through long, multi-step tasks on its own up to a generous safety ceiling. "Checkpoint" pauses
          periodically and shows a Continue button so you stay in control.
        </p>
        {settings.continueMode === 'checkpoint' && (
          <div className="space-y-1">
            <label className="block text-sm">Steps per checkpoint</label>
            <input
              type="number"
              min={1}
              step={1}
              className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
              value={settings.turnCheckpointSteps}
              onChange={(e) => void patch({ turnCheckpointSteps: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
        )}
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
