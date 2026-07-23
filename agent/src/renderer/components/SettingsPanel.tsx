import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { DEFAULT_EMBEDDINGS_MODEL } from '@shared/types'
import type { ScheduledTask } from '@shared/types'

export function SettingsPanel() {
  const { settings, models, shells, indexStatus, setSettings, setModels, setShells, setIndexStatus, settingsFocusSection, setSettingsFocusSection } =
    useAppStore()
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

  const integrationsRef = useRef<HTMLDivElement>(null)
  const automationRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.klenny.listModels(true).then(setModels)
    void window.klenny.listShells().then(setShells)
    void window.klenny.getIndexStatus().then(setIndexStatus)
    void window.klenny.getDiscordStatus().then(setDiscordStatus)
    void window.klenny.listScheduledTasks().then(setTasks)
    const unsub = window.klenny.onDiscordStatus((status) => setDiscordStatus(status))
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!settingsFocusSection) return
    const el = settingsFocusSection === 'integrations' ? integrationsRef.current : settingsFocusSection === 'automation' ? automationRef.current : null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setSettingsFocusSection(null)
  }, [settingsFocusSection])

  const refreshTasks = () => void window.klenny.listScheduledTasks().then(setTasks)

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

      <section className="mb-6 space-y-2">
        <h3 className="font-medium">Theme</h3>
        <select className="w-full px-3 py-2 bg-klenny-bg border border-klenny-border rounded" value={settings.theme} onChange={(e) => void patch({ theme: e.target.value as 'dark' | 'light' })}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </section>

      <section ref={integrationsRef} className="mb-6 space-y-4 border-t border-klenny-border pt-6">
        <h3 className="font-medium text-lg">Integrations</h3>

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

      <section ref={automationRef} className="mb-6 space-y-2 border-t border-klenny-border pt-6">
        <h3 className="font-medium text-lg">Automation permissions</h3>
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

      <section className="mb-6 space-y-2 border-t border-klenny-border pt-6">
        <h3 className="font-medium text-lg">Scheduled tasks</h3>
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
                    maxCostUsd: null
                  })
                  .then(() => {
                    setNewTaskName('')
                    setNewTaskPrompt('')
                    refreshTasks()
                  })
              }
            >
              Add task
            </button>
          </div>
          <p className="text-xs text-klenny-muted">Standard 5-field cron syntax, evaluated in your local time.</p>
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
              <p className="text-klenny-muted text-xs font-mono">{t.schedule}</p>
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

      <section className="space-y-2 border-t border-klenny-border pt-6">
        <h3 className="font-medium text-lg">Background &amp; startup</h3>
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
  )
}
