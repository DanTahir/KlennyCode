import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { DEFAULT_MAIN_MODEL, DEFAULT_SUBAGENT_MODEL, DEFAULT_UTILITY_MODEL, DEFAULT_AUTOMATION_PERMISSIONS } from '@shared/types'

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
  codebaseIndexEnabled: false,
  embeddingsModel: null,
  vectorStoreBackend: 'local',
  pineconeIndexName: null,
  hasPineconeKey: false,
  continueMode: 'auto',
  turnCheckpointSteps: 40,
  hasGmailToken: false,
  gmailAccountEmail: null,
  gmailClientId: null,
  gmailClientSecret: null,
  lastGmailRefreshError: null,
  hasDiscordToken: false,
  discordBotTag: null,
  lastDiscordConnectionError: null,
  automationPermissions: DEFAULT_AUTOMATION_PERMISSIONS,
  schedulerEnabled: true,
  minimizeToTray: false,
  startOnLogin: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function apiKeyPath(): string {
  return join(app.getPath('userData'), 'api-key.enc')
}

function pineconeKeyPath(): string {
  return join(app.getPath('userData'), 'pinecone-key.enc')
}

function gmailTokenPath(): string {
  return join(app.getPath('userData'), 'gmail-token.enc')
}

function discordTokenPath(): string {
  return join(app.getPath('userData'), 'discord-token.enc')
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      ...DEFAULTS,
      ...parsed,
      automationPermissions: { ...DEFAULT_AUTOMATION_PERMISSIONS, ...parsed.automationPermissions },
      hasApiKey: await hasApiKey(),
      hasPineconeKey: await hasPineconeKey(),
      hasGmailToken: await hasGmailToken(),
      hasDiscordToken: await hasDiscordToken()
    }
  } catch {
    return {
      ...DEFAULTS,
      hasApiKey: await hasApiKey(),
      hasPineconeKey: await hasPineconeKey(),
      hasGmailToken: await hasGmailToken(),
      hasDiscordToken: await hasDiscordToken()
    }
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  delete (next as { hasApiKey?: boolean }).hasApiKey
  delete (next as { hasPineconeKey?: boolean }).hasPineconeKey
  delete (next as { hasGmailToken?: boolean }).hasGmailToken
  delete (next as { hasDiscordToken?: boolean }).hasDiscordToken
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

export async function hasPineconeKey(): Promise<boolean> {
  try {
    const buf = await readFile(pineconeKeyPath())
    return safeStorage.isEncryptionAvailable() && buf.length > 0
  } catch {
    return false
  }
}

export async function getPineconeKey(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = await readFile(pineconeKeyPath())
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export async function setPineconeKey(key: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available on this system.')
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(key.trim())
  await writeFile(pineconeKeyPath(), encrypted)
}

export async function clearPineconeKey(): Promise<void> {
  try {
    await writeFile(pineconeKeyPath(), Buffer.alloc(0))
  } catch {
    // ignore
  }
}

// ---------- Gmail OAuth token (JSON blob: access_token, refresh_token, expiry_date, ...) ----------

export interface GmailTokenBlob {
  access_token?: string | null
  refresh_token?: string | null
  expiry_date?: number | null
  scope?: string | null
  token_type?: string | null
  id_token?: string | null
}

export async function hasGmailToken(): Promise<boolean> {
  try {
    const buf = await readFile(gmailTokenPath())
    return safeStorage.isEncryptionAvailable() && buf.length > 0
  } catch {
    return false
  }
}

export async function getGmailToken(): Promise<GmailTokenBlob | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = await readFile(gmailTokenPath())
    if (buf.length === 0) return null
    return JSON.parse(safeStorage.decryptString(buf)) as GmailTokenBlob
  } catch {
    return null
  }
}

export async function setGmailToken(token: GmailTokenBlob): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available on this system.')
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(token))
  await writeFile(gmailTokenPath(), encrypted)
}

export async function clearGmailToken(): Promise<void> {
  try {
    await writeFile(gmailTokenPath(), Buffer.alloc(0))
  } catch {
    // ignore
  }
}

// ---------- Discord bot token ----------

export async function hasDiscordToken(): Promise<boolean> {
  try {
    const buf = await readFile(discordTokenPath())
    return safeStorage.isEncryptionAvailable() && buf.length > 0
  } catch {
    return false
  }
}

export async function getDiscordToken(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = await readFile(discordTokenPath())
    if (buf.length === 0) return null
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export async function setDiscordToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secure storage is not available on this system.')
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  const encrypted = safeStorage.encryptString(token.trim())
  await writeFile(discordTokenPath(), encrypted)
}

export async function clearDiscordToken(): Promise<void> {
  try {
    await writeFile(discordTokenPath(), Buffer.alloc(0))
  } catch {
    // ignore
  }
}
