import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { DEFAULT_MAIN_MODEL, DEFAULT_SUBAGENT_MODEL, DEFAULT_UTILITY_MODEL } from '@shared/types'

const DEFAULTS: AppSettings = {
  hasApiKey: false,
  mainModel: DEFAULT_MAIN_MODEL,
  subagentModel: DEFAULT_SUBAGENT_MODEL,
  utilityModel: DEFAULT_UTILITY_MODEL,
  approvalMode: 'manual',
  theme: 'dark',
  spendingCapUsd: null,
  spendingCapPeriod: 'session',
  autoMemoryEnabled: true,
  promptCachingEnabled: true,
  lastWorkspace: null,
  shellId: null,
  collapseSupersededResultsEnabled: true
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function apiKeyPath(): string {
  return join(app.getPath('userData'), 'api-key.enc')
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { ...DEFAULTS, ...parsed, hasApiKey: await hasApiKey() }
  } catch {
    return { ...DEFAULTS, hasApiKey: await hasApiKey() }
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  delete (next as { hasApiKey?: boolean }).hasApiKey
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  return loadSettings()
}

export async function hasApiKey(): Promise<boolean> {
  try {
    const buf = await readFile(apiKeyPath())
    return safeStorage.isEncryptionAvailable() && buf.length > 0
  } catch {
    return false
  }
}

export async function getApiKey(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = await readFile(apiKeyPath())
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export async function setApiKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available on this system.')
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(key.trim())
  await writeFile(apiKeyPath(), encrypted)
}

export async function clearApiKey(): Promise<void> {
  try {
    await writeFile(apiKeyPath(), Buffer.alloc(0))
  } catch {
    // ignore
  }
}
