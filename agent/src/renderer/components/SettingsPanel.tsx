import { useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '../store/useAppStore'
import { BRAND_NAME_MAX_LENGTH, DEFAULT_BRAND_NAME, DEFAULT_EMBEDDINGS_MODEL } from '@shared/types'
import type { ScheduledTask } from '@shared/types'

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export function SettingsPanel() {
  const {
    settings,
    models,
    shells,
    indexStatus,
    setSettings,
    setModels,
    setShells,
    setIndexStatus,
    settingsFocusSection,
    setSettingsFocusSection,
    customIconUrl,
    setCustomIconUrl,
    customRunningGifUrl,
    setCustomRunningGifUrl
  } = useAppStore()
  const [brandNameInput, setBrandNameInput] = useState('')
  const [iconError, setIconError] = useState<string | null>(null)
  const [gifError, setGifError] = useState<string | null>(null)
  const [uploadingIcon, setUploadingIcon] = useState(false)
  const [uploadingGif, setUploadingGif] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [search, setSearch] = useState('')
  const [providerOnly, setProviderOnly] = useState('')
  const [providerOrder, setProviderOrder] = useState('')
  const [showAdvancedProvider, setShowAdvancedProvider] = useState(false)
  const [pineconeKey, setPineconeKey] = useState('')

  // Gmail / Discord integrations
  const [gmailClientId, setGmailClientId] = useState('')
  const [gmailClientSecret, setGmailClientSecret] = useState('')
  const [gmailConnecting, setGmailConnecting] = useState(false)
  const [gmailError, setGmailError] = useState<string | null>(null)
  const [discordToken, setDiscordToken] = useState('')
  const [discordConnecting, setDiscordConnecting] = useState(false)
  const [discordError, setDiscordError] = useState<string | null>(null)
  const [discordStatus, setDiscordStatus] = useState<{ connected: boolean; botTag: string | null; lastError: string | null } | null>(null)

  // Scheduled tasks
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [newTaskName, setNewTaskName] = useState('')
  const [newTaskPrompt, setNewTaskPrompt] = useState('')
  const [newTaskSchedule, setNewTaskSchedule] = useState('0 8 * * *')
  const [newTaskMaxRuns, setNewTaskMaxRuns] = useState('')

  // Secondary sidebar: top-level settings categories, each anchored to a section group below.
  const containerRef = useRef<HTMLDivElement>(null)
  const generalRef = useRef<HTMLDivElement>(null)
  const modelsRef = useRef<HTMLDivElement>(null)
  const behaviorRef = useRef<HTMLDivElement>(null)
  const codebaseRef = useRef<HTMLDivElement>(null)
  const appearanceRef = useRef<HTMLDivElement>(null)
  const integrationsRef = useRef<HTMLDivElement>(null)
  const automationRef = useRef<HTMLDivElement>(null)
  const backgroundRef = useRef<HTMLDivElement>(null)

  const categories: { id: string; label: string; ref: RefObject<HTMLDivElement> }[] = [
    { id: 'general', label: 'General', ref: generalRef },
    { id: 'models', label: 'Models & cost', ref: modelsRef },
    { id: 'behavior', label: 'Behavior', ref: behaviorRef },
    { id: 'codebase', label: 'Codebase search', ref: codebaseRef },
    { id: 'appearance', label: 'Appearance', ref: appearanceRef },
    { id: 'integrations', label: 'Integrations', ref: integrationsRef },
    { id: 'automation', label: 'Automation', ref: automationRef },
    { id: 'background', label: 'Background & startup', ref: backgroundRef }
  ]

  const [activeSection, setActiveSection] = useState('general')

  const scrollToSection = (id: string) => {
    categories.find((c) => c.id === id)?.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  useEffect(() => {
    void window.klenny.listModels(true).then(setModels)
    void window.klenny.listShells().then(setShells)
    void window.klenny.getIndexStatus().then(setIndexStatus)
    void window.klenny.getDiscordStatus().then(setDiscordStatus)
    void window.klenny.listScheduledTasks().then(setTasks)
    const unsub = window.klenny.onDiscordStatus((status) => setDiscordStatus(status))
    return () => unsub()
  }, [])

  // Scrollspy: highlight whichever category's section is nearest the top of the scroll area.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const targets = categories.map((c) => c.ref.current).filter((el): el is HTMLDivElement => el != null)
    if (targets.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.filter((e) => e.isIntersecting)
        if (intersecting.length === 0) return
        intersecting.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const id = intersecting[0]?.target.getAttribute('data-section-id')
        if (id) setActiveSection(id)
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    )
    targets.forEach((t) => observer.observe(t))
    return () => observer.disconnect()
    // Refs are stable across renders — this only needs to run once the scroll container exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!settingsFocusSection) return
    scrollToSection(settingsFocusSection)
    setActiveSection(settingsFocusSection)
    setSettingsFocusSection(null)
  }, [settingsFocusSection])

  const refreshTasks = () => void window.klenny.listScheduledTasks().then(setTasks)

  useEffect(() => {
    if (!settings?.providerPreference) return
    setProviderOnly((settings.providerPreference.only ?? []).join(', '))
    setProviderOrder((settings.providerPreference.order ?? []).join(', '))
  }, [settings?.providerPreference])

  useEffect(() => {
    setBrandNameInput(settings?.brandName ?? '')
  }, [settings?.brandName])

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
    <div className="flex-1 flex min-h-0">
      <nav className="w-48 flex-shrink-0 border-r border-klenny-border overflow-y-auto py-6 px-2">
        <ul className="space-y-0.5">
          {categories.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => scrollToSection(c.id)}
                className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                  activeSection === c.id
                    ? 'bg-klenny-accent/15 text-klenny-accent font-medium'
                    : 'text-klenny-muted hover:text-klenny-text hover:bg-klenny-panel2'
                }`}
              >
                {c.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div ref={containerRef} className="flex-1 overflow-y-auto p-6 max-w-3xl">
        <h2 className="text-xl font-semibold mb-4">Settings</h2>

        <div ref={generalRef} data-section-id="general" className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">General</h2>

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
        </div>

        <div ref={modelsRef} data-section-id="models" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Models &amp; cost</h2>

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
        </div>

        <div ref={behaviorRef} data-section-id="behavior" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Behavior</h2>

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
            <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.approvalMode} onChange={(e) => void patch({ approvalMode: e.target.value as 'manual' | 'auto' | 'command' })}>
              <option value="manual">Manual review (default)</option>
              <option value="command">Command approve — auto-apply edits, manually approve commands</option>
              <option value="auto">Auto-apply with checkpoints</option>
            </select>
            <p className="text-xs text-klenny-muted">
              This is the default for new tabs — each chat tab can override it individually from the dropdown next to Send.
            </p>
          </section>
        </div>

        <div ref={codebaseRef} data-section-id="codebase" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Codebase search</h2>

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
        </div>

        <div ref={appearanceRef} data-section-id="appearance" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Appearance</h2>

          <section className="mb-6 space-y-2">
            <h3 className="font-medium">Theme</h3>
            <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.theme} onChange={(e) => void patch({ theme: e.target.value as 'dark' | 'light' })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </section>

          <section className="mb-6 space-y-3">
            <h3 className="font-medium">Rebrand</h3>
            <p className="text-xs text-klenny-muted">
              Rebrand the app to your own name and imagery — shown in the sidebar, header, window/taskbar icon, and
              system tray. Everything here can be restored to Klenny's defaults with one click.
            </p>

            <div className="space-y-1">
              <label className="block text-sm">App name</label>
              <input
                className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                placeholder={DEFAULT_BRAND_NAME}
                maxLength={BRAND_NAME_MAX_LENGTH}
                value={brandNameInput}
                onChange={(e) => setBrandNameInput(e.target.value.slice(0, BRAND_NAME_MAX_LENGTH))}
                onBlur={() => void patch({ brandName: brandNameInput.trim() || null })}
              />
              <p className="text-xs text-klenny-muted">
                {brandNameInput.length}/{BRAND_NAME_MAX_LENGTH} characters. Leave blank to use "{DEFAULT_BRAND_NAME}".
              </p>
            </div>

            <div className="space-y-1">
              <label className="block text-sm">App icon</label>
              <div className="flex items-center gap-3">
                <img
                  src={customIconUrl ?? undefined}
                  alt="Current app icon"
                  className={`w-10 h-10 rounded-full object-cover border border-klenny-border ${customIconUrl ? '' : 'hidden'}`}
                />
                <label className="px-3 py-1 rounded border border-klenny-border text-sm cursor-pointer hover:bg-klenny-panel2">
                  {uploadingIcon ? 'Uploading…' : 'Upload icon…'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    className="hidden"
                    disabled={uploadingIcon}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      setIconError(null)
                      setUploadingIcon(true)
                      void readFileAsDataUrl(file)
                        .then((dataUrl) => window.klenny.setCustomIcon(dataUrl))
                        .then((s) => {
                          setSettings(s)
                          return window.klenny.getCustomIcon()
                        })
                        .then(setCustomIconUrl)
                        .catch((err) => setIconError(err instanceof Error ? err.message : String(err)))
                        .finally(() => setUploadingIcon(false))
                    }}
                  />
                </label>
                {customIconUrl && (
                  <button
                    className="px-3 py-1 rounded border border-klenny-border text-sm"
                    onClick={() =>
                      void window.klenny
                        .clearCustomIcon()
                        .then((s) => {
                          setSettings(s)
                          setCustomIconUrl(null)
                        })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-klenny-muted">PNG or JPEG. Used for the sidebar avatar, window/taskbar icon, and tray icon.</p>
              {iconError && <p className="text-xs text-red-400">{iconError}</p>}
            </div>

            <div className="space-y-1">
              <label className="block text-sm">"AI is working" animation</label>
              <div className="flex items-center gap-3">
                <img
                  src={customRunningGifUrl ?? undefined}
                  alt="Current running animation"
                  className={`h-10 w-10 rounded-md object-cover border border-klenny-border ${customRunningGifUrl ? '' : 'hidden'}`}
                />
                <label className="px-3 py-1 rounded border border-klenny-border text-sm cursor-pointer hover:bg-klenny-panel2">
                  {uploadingGif ? 'Uploading…' : 'Upload animation…'}
                  <input
                    type="file"
                    accept="image/gif,image/webp"
                    className="hidden"
                    disabled={uploadingGif}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      setGifError(null)
                      setUploadingGif(true)
                      void readFileAsDataUrl(file)
                        .then((dataUrl) => window.klenny.setCustomRunningGif(dataUrl))
                        .then((s) => {
                          setSettings(s)
                          return window.klenny.getCustomRunningGif()
                        })
                        .then(setCustomRunningGifUrl)
                        .catch((err) => setGifError(err instanceof Error ? err.message : String(err)))
                        .finally(() => setUploadingGif(false))
                    }}
                  />
                </label>
                {customRunningGifUrl && (
                  <button
                    className="px-3 py-1 rounded border border-klenny-border text-sm"
                    onClick={() =>
                      void window.klenny
                        .clearCustomRunningGif()
                        .then((s) => {
                          setSettings(s)
                          setCustomRunningGifUrl(null)
                        })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
              <p className="text-xs text-klenny-muted">GIF or animated WebP. Shown in chat while the agent is working.</p>
              {gifError && <p className="text-xs text-red-400">{gifError}</p>}
            </div>

            <button
              className="px-3 py-1 rounded border border-klenny-border text-sm text-klenny-muted hover:text-klenny-accent hover:border-klenny-accent"
              onClick={() =>
                void window.klenny.resetBranding().then((s) => {
                  setSettings(s)
                  setCustomIconUrl(null)
                  setCustomRunningGifUrl(null)
                  setBrandNameInput('')
                  setIconError(null)
                  setGifError(null)
                })
              }
            >
              Reset appearance to defaults
            </button>
          </section>
        </div>

        <div ref={integrationsRef} data-section-id="integrations" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Integrations</h2>

          <section className="mb-6 space-y-4">
            <div className="space-y-2">
              <h4 className="font-medium text-sm">Gmail</h4>
              {settings.hasGmailToken ? (
                <div className="text-sm space-y-1">
                  <p>Connected as {settings.gmailAccountEmail ?? 'unknown'}.</p>
                  <button
                    className="px-3 py-1 rounded border border-klenny-border text-sm"
                    onClick={() =>
                      void window.klenny
                        .disconnectGmail()
                        .then(() => window.klenny.getSettings())
                        .then(setSettings)
                    }
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-klenny-muted">
                    Register your own OAuth client in{' '}
                    <a
                      className="text-klenny-accent underline"
                      href="https://console.cloud.google.com/apis/credentials"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google Cloud Console
                    </a>{' '}
                    (APIs &amp; Services → Credentials → OAuth client ID → Desktop app), then paste the Client ID/Secret
                    below. Klenny never sees a shared client — this is entirely your own app registration.
                  </p>
                  <input
                    className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                    placeholder={settings.gmailClientId ? 'Client ID saved (enter to replace)' : 'Google OAuth Client ID'}
                    value={gmailClientId}
                    onChange={(e) => setGmailClientId(e.target.value)}
                    onBlur={() => gmailClientId && void patch({ gmailClientId }).then(() => setGmailClientId(''))}
                  />
                  <input
                    type="password"
                    className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                    placeholder={settings.gmailClientSecret ? 'Client Secret saved (enter to replace)' : 'Google OAuth Client Secret'}
                    value={gmailClientSecret}
                    onChange={(e) => setGmailClientSecret(e.target.value)}
                    onBlur={() => gmailClientSecret && void patch({ gmailClientSecret }).then(() => setGmailClientSecret(''))}
                  />
                  <button
                    className="px-3 py-1 rounded bg-klenny-accent text-black text-sm disabled:opacity-60"
                    disabled={gmailConnecting || (!settings.gmailClientId && !gmailClientId)}
                    onClick={() => {
                      setGmailConnecting(true)
                      setGmailError(null)
                      void window.klenny
                        .connectGmail()
                        .then(() => window.klenny.getSettings())
                        .then(setSettings)
                        .catch((e) => setGmailError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setGmailConnecting(false))
                    }}
                  >
                    {gmailConnecting ? 'Opening browser…' : 'Connect Gmail'}
                  </button>
                  {gmailError && <p className="text-xs text-red-400">{gmailError}</p>}
                  {settings.lastGmailRefreshError && (
                    <p className="text-xs text-red-400">Last error: {settings.lastGmailRefreshError}</p>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-klenny-border pt-4">
              <h4 className="font-medium text-sm">Discord</h4>
              <p className="text-xs text-klenny-muted">
                Create a bot application in the Discord Developer Portal, invite it to your server(s), then paste its bot
                token below. Bot-account only — no personal-account automation.
              </p>
              {settings.hasDiscordToken ? (
                <div className="text-sm space-y-1">
                  <p>
                    Connected{discordStatus?.botTag ? ` as ${discordStatus.botTag}` : ''} —{' '}
                    {discordStatus?.connected ? 'online' : 'reconnecting…'}
                  </p>
                  <button
                    className="px-3 py-1 rounded border border-klenny-border text-sm"
                    onClick={() =>
                      void window.klenny
                        .disconnectDiscord()
                        .then(() => window.klenny.getSettings())
                        .then(setSettings)
                    }
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                    placeholder="Discord bot token"
                    value={discordToken}
                    onChange={(e) => setDiscordToken(e.target.value)}
                  />
                  <button
                    className="px-3 py-1 rounded bg-klenny-accent text-black text-sm disabled:opacity-60"
                    disabled={discordConnecting || !discordToken}
                    onClick={() => {
                      setDiscordConnecting(true)
                      setDiscordError(null)
                      void window.klenny
                        .connectDiscord(discordToken)
                        .then(() => window.klenny.getSettings())
                        .then(setSettings)
                        .then(() => setDiscordToken(''))
                        .catch((e) => setDiscordError(e instanceof Error ? e.message : String(e)))
                        .finally(() => setDiscordConnecting(false))
                    }}
                  >
                    {discordConnecting ? 'Connecting…' : 'Connect Discord'}
                  </button>
                  {discordError && <p className="text-xs text-red-400">{discordError}</p>}
                  {settings.lastDiscordConnectionError && (
                    <p className="text-xs text-red-400">Last error: {settings.lastDiscordConnectionError}</p>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        <div ref={automationRef} data-section-id="automation" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Automation</h2>

          <section className="mb-6 space-y-2">
            <h3 className="font-medium">Automation permissions</h3>
            <p className="text-xs text-klenny-muted">
              Controls which actions the agent may take automatically — including when running unattended (scheduled
              tasks, Discord-triggered runs). There is no "ask me" option for these: each is either fully allowed or
              fully blocked.
            </p>
            {(
              [
                ['gmail.read', 'Read Gmail messages'],
                ['gmail.send', 'Send email via Gmail'],
                ['discord.read', 'Listen to inbound Discord messages/commands'],
                ['discord.post', 'Post messages to Discord'],
                ['scheduler.run', 'Allow scheduled background tasks to run at all']
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.automationPermissions[key] === 'auto'}
                  onChange={(e) =>
                    void patch({
                      automationPermissions: { ...settings.automationPermissions, [key]: e.target.checked ? 'auto' : 'off' }
                    })
                  }
                />
                {label}
              </label>
            ))}
          </section>

          <section className="mb-6 space-y-2">
            <h3 className="font-medium">Scheduled tasks</h3>
            <p className="text-xs text-klenny-muted">
              Recurring background tasks that run as unattended agents on a cron schedule, even while the app is
              minimized to the tray. You can also ask the agent in chat to create these for you.
            </p>
            <div className="space-y-2 border border-klenny-border rounded p-3">
              <input
                className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                placeholder="Task name (e.g. Morning inbox summary)"
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
              />
              <textarea
                className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                placeholder="Prompt (e.g. Check my unread email and summarize anything important)"
                rows={2}
                value={newTaskPrompt}
                onChange={(e) => setNewTaskPrompt(e.target.value)}
              />
              <div className="flex gap-2 items-center">
                <input
                  className="flex-1 px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm font-mono"
                  placeholder="Cron schedule (e.g. 0 8 * * *)"
                  value={newTaskSchedule}
                  onChange={(e) => setNewTaskSchedule(e.target.value)}
                />
                <input
                  className="w-28 px-3 py-2 bg-klenny-bg border border-klenny-border rounded text-sm"
                  type="number"
                  min={1}
                  placeholder="Max runs"
                  title="Optional: stop and delete this task after it has fired this many times. Leave blank to run indefinitely on schedule."
                  value={newTaskMaxRuns}
                  onChange={(e) => setNewTaskMaxRuns(e.target.value)}
                />
                <button
                  className="px-3 py-1 rounded bg-klenny-accent text-black text-sm disabled:opacity-60"
                  disabled={!newTaskName || !newTaskPrompt || !newTaskSchedule}
                  onClick={() =>
                    void window.klenny
                      .createScheduledTask({
                        name: newTaskName,
                        prompt: newTaskPrompt,
                        schedule: newTaskSchedule,
                        targetWorkspace: null,
                        maxCostUsd: null,
                        maxRuns: newTaskMaxRuns ? Number(newTaskMaxRuns) : null
                      })
                      .then(() => {
                        setNewTaskName('')
                        setNewTaskPrompt('')
                        setNewTaskMaxRuns('')
                        refreshTasks()
                      })
                  }
                >
                  Add task
                </button>
              </div>
              <p className="text-xs text-klenny-muted">
                Standard 5-field cron syntax, evaluated in your local time. Set "Max runs" to make the task delete itself after N firings
                (e.g. 1 for a one-time reminder) — leave blank to run indefinitely.
              </p>
            </div>

            <div className="space-y-2">
              {tasks.length === 0 && <p className="text-xs text-klenny-muted">No scheduled tasks yet.</p>}
              {tasks.map((t) => (
                <div key={t.id} className="border border-klenny-border rounded p-3 text-sm space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{t.name}</span>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={t.enabled}
                          onChange={(e) =>
                            void window.klenny.updateScheduledTask(t.id, { enabled: e.target.checked }).then(refreshTasks)
                          }
                        />
                        Enabled
                      </label>
                      <button
                        className="text-xs text-klenny-muted hover:text-red-400"
                        onClick={() => void window.klenny.deleteScheduledTask(t.id).then(refreshTasks)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <p className="text-klenny-muted text-xs font-mono">
                    {t.schedule}
                    {t.maxRuns != null && ` · run ${Math.min(t.runCount + 1, t.maxRuns)}/${t.maxRuns}`}
                  </p>
                  <p className="text-xs">{t.prompt}</p>
                  <p className="text-xs text-klenny-muted">
                    {t.lastRunAt
                      ? `Last run: ${new Date(t.lastRunAt).toLocaleString()} — ${t.lastExitStatus ?? 'unknown'}`
                      : 'Never run yet'}
                    {t.nextRunAt && ` · Next run: ${new Date(t.nextRunAt).toLocaleString()}`}
                  </p>
                  {t.lastOutputPreview && <p className="text-xs text-klenny-muted italic">"{t.lastOutputPreview}"</p>}
                </div>
              ))}
            </div>
          </section>

          <section className="mb-6 space-y-2">
            <h3 className="font-medium">Browser automation</h3>
            <p className="text-xs text-klenny-muted">
              Lets the agent drive a local Chromium browser (navigate, click, type, read pages) using Playwright. Off
              by default. Interactive sessions run headed so you can watch; subagent and scheduled-task sessions
              always run headless. Never enables reaching cloud metadata endpoints, regardless of any setting below.
            </p>
            <div className="space-y-3 border border-klenny-border rounded p-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="w-24 text-klenny-muted">Policy</span>
                <select
                  className="px-2 py-1 bg-klenny-bg border border-klenny-border rounded text-sm"
                  value={settings.browserAutomation.policy}
                  onChange={(e) =>
                    void patch({
                      browserAutomation: { ...settings.browserAutomation, policy: e.target.value as typeof settings.browserAutomation.policy }
                    })
                  }
                >
                  <option value="off">Off — browser tool always fails</option>
                  <option value="ask">Ask — approve each click/type/etc, with a screenshot preview</option>
                  <option value="auto">Auto — mutating actions execute immediately</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.browserAutomation.allowPrivateNetwork}
                  onChange={(e) =>
                    void patch({
                      browserAutomation: { ...settings.browserAutomation, allowPrivateNetwork: e.target.checked }
                    })
                  }
                />
                Allow private network access (interactive sessions — needed for local dev servers)
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.browserAutomation.allowPrivateNetworkUnattended}
                  onChange={(e) =>
                    void patch({
                      browserAutomation: { ...settings.browserAutomation, allowPrivateNetworkUnattended: e.target.checked }
                    })
                  }
                />
                Allow private network access for subagent/scheduled-task sessions (stricter — off by default)
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.browserAutomation.allowEvaluate}
                  onChange={(e) =>
                    void patch({
                      browserAutomation: { ...settings.browserAutomation, allowEvaluate: e.target.checked }
                    })
                  }
                />
                <span>
                  Allow JavaScript evaluation in the page{' '}
                  <span className="text-yellow-500" title="Runs arbitrary agent-generated JS in the page context. Never available to subagents regardless of this setting.">
                    ⚠️
                  </span>
                </span>
              </label>

              <label className="flex items-center gap-2 text-sm">
                <span className="w-40 text-klenny-muted">Browser executable path</span>
                <input
                  className="flex-1 px-2 py-1 bg-klenny-bg border border-klenny-border rounded text-sm"
                  placeholder="Leave blank to use Playwright's bundled Chromium"
                  value={settings.browserAutomation.browserExecutablePath ?? ''}
                  onChange={(e) =>
                    void patch({
                      browserAutomation: { ...settings.browserAutomation, browserExecutablePath: e.target.value || null }
                    })
                  }
                />
              </label>

              <label className="flex items-center gap-2 text-sm">
                <span className="w-40 text-klenny-muted">Max concurrent sessions</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  className="w-20 px-2 py-1 bg-klenny-bg border border-klenny-border rounded text-sm"
                  value={settings.browserAutomation.maxConcurrentSessions}
                  onChange={(e) =>
                    void patch({
                      browserAutomation: {
                        ...settings.browserAutomation,
                        maxConcurrentSessions: Math.min(10, Math.max(1, Number(e.target.value) || 1))
                      }
                    })
                  }
                />
              </label>
            </div>
          </section>
        </div>

        <div ref={backgroundRef} data-section-id="background" className="mb-8 border-t border-klenny-border pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-klenny-muted mb-3">Background &amp; startup</h2>

          <section className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.minimizeToTray}
                onChange={(e) => void patch({ minimizeToTray: e.target.checked })}
              />
              Minimize to system tray instead of quitting when the window is closed
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.startOnLogin}
                onChange={(e) => void patch({ startOnLogin: e.target.checked })}
              />
              Start Klenny Code automatically when I log in
            </label>
            <p className="text-xs text-klenny-muted">
              Needed for scheduled tasks and the Discord bot to keep running when you're not actively using the app.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
