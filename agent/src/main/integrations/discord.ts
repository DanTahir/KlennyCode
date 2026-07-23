/**
 * Discord integration (Phase 3 of the Personal Assistant Platform plan).
 *
 * Bot-account-only, per user requirement (no personal-account automation — ToS compliance).
 * The user creates a bot application in the Discord Developer Portal, invites it to their
 * server(s), and pastes the bot token into Settings -> Integrations -> Discord. Klenny then
 * runs a persistent discord.js gateway client for the lifetime of the app/tray process.
 *
 * Inbound: DMs to the bot, or messages that @-mention it / use a "!klenny" prefix in permitted
 * guild channels, are dispatched into a subagent run via `onInboundCommand` (wired up in
 * orchestrator.ts / ipc.ts to avoid a circular import between this module and the orchestrator).
 * Outbound: `discordPostMessageTool` lets any run post to a channel/DM.
 */
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import type { Message } from 'discord.js'
import type { ToolResultPayload } from '@shared/types'
import { getDiscordToken, setDiscordToken, clearDiscordToken, loadSettings, saveSettings } from '../settings'

export interface DiscordStatus {
  connected: boolean
  botTag: string | null
  lastError: string | null
}

let client: Client | null = null
let currentStatus: DiscordStatus = { connected: false, botTag: null, lastError: null }
const statusListeners = new Set<(status: DiscordStatus) => void>()

/** Set by orchestrator.ts at startup to avoid a circular import — receives the plain text of a
 *  qualifying inbound message and must resolve with the text reply to send back. */
let inboundHandler: ((text: string) => Promise<string>) | null = null

export function setInboundCommandHandler(handler: (text: string) => Promise<string>): void {
  inboundHandler = handler
}

export function onDiscordStatusChange(cb: (status: DiscordStatus) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

function setStatus(patch: Partial<DiscordStatus>): void {
  currentStatus = { ...currentStatus, ...patch }
  for (const cb of statusListeners) cb(currentStatus)
}

export function getDiscordStatus(): DiscordStatus {
  return currentStatus
}

const COMMAND_PREFIX = '!klenny'

function shouldHandle(message: Message): boolean {
  if (message.author.bot) return false
  if (!message.guild) return true // DM
  const mentioned = client ? message.mentions.has(client.user!.id) : false
  return mentioned || message.content.trim().toLowerCase().startsWith(COMMAND_PREFIX)
}

function stripCommandText(message: Message): string {
  let text = message.content
  if (client?.user) text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim()
  if (text.toLowerCase().startsWith(COMMAND_PREFIX)) text = text.slice(COMMAND_PREFIX.length).trim()
  return text
}

/** Starts the persistent gateway connection using the stored bot token, if any. Safe to call
 *  multiple times (e.g. on app launch and again after a fresh Settings connect) — tears down
 *  any existing client first. */
export async function startDiscordClient(): Promise<void> {
  await stopDiscordClient()
  const token = await getDiscordToken()
  if (!token) return

  const c = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel]
  })

  c.on('ready', () => {
    setStatus({ connected: true, botTag: c.user?.tag ?? null, lastError: null })
    void saveSettings({ discordBotTag: c.user?.tag ?? null, hasDiscordToken: true, lastDiscordConnectionError: null })
  })

  c.on('error', (e) => {
    setStatus({ lastError: e.message })
  })

  c.on('messageCreate', (message) => {
    void (async () => {
      try {
        if (!shouldHandle(message)) return
        const settingsNow = await loadSettings()
        if (settingsNow.automationPermissions['discord.read'] !== 'auto') return
        if (!inboundHandler) return
        const text = stripCommandText(message)
        if (!text) return
        await message.channel.sendTyping().catch(() => {})
        const reply = await inboundHandler(text)
        await message.reply(reply.slice(0, 1900)) // Discord's hard 2000-char message limit
      } catch (e) {
        try {
          await message.reply(`Sorry, something went wrong: ${e instanceof Error ? e.message : String(e)}`)
        } catch {
          // ignore — best-effort error reply
        }
      }
    })()
  })

  client = c
  try {
    await c.login(token)
    // login() resolving only means the WebSocket identified successfully — the 'ready' event
    // (which sets currentStatus.connected/botTag above) can fire a moment later. Wait for it
    // explicitly so callers like connectDiscord() see an accurate status immediately after.
    if (!c.isReady()) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for Discord gateway to become ready.')), 15_000)
        c.once('ready', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // Only clear the stored token on an actual auth rejection (invalid/revoked token), not on
    // transient network failures — discord.js already retries those internally via its own
    // reconnect logic once logged in successfully.
    const isAuthError = /token|unauthorized|401/i.test(message)
    if (isAuthError) {
      await clearDiscordToken()
      await saveSettings({ hasDiscordToken: false, discordBotTag: null, lastDiscordConnectionError: message })
    } else {
      await saveSettings({ lastDiscordConnectionError: message })
    }
    setStatus({ connected: false, lastError: message })
    client = null
  }
}

export async function stopDiscordClient(): Promise<void> {
  if (client) {
    await client.destroy().catch(() => {})
    client = null
  }
  setStatus({ connected: false })
}

export async function connectDiscord(botToken: string): Promise<{ botTag: string }> {
  await setDiscordToken(botToken)
  await saveSettings({ hasDiscordToken: true, lastDiscordConnectionError: null })
  await startDiscordClient()
  if (!currentStatus.connected || !currentStatus.botTag) {
    const err = currentStatus.lastError ?? 'Failed to connect \u2014 check that the bot token is correct.'
    throw new Error(err)
  }
  return { botTag: currentStatus.botTag }
}

export async function disconnectDiscord(): Promise<void> {
  await stopDiscordClient()
  await clearDiscordToken()
  await saveSettings({ hasDiscordToken: false, discordBotTag: null, lastDiscordConnectionError: null })
}

export async function discordPostMessageTool(args: { channelId: string; text: string }): Promise<ToolResultPayload> {
  try {
    const settings = await loadSettings()
    if (settings.automationPermissions['discord.post'] !== 'auto') {
      return {
        ok: false,
        summary: 'discord_post_message is disabled by Automation Permissions',
        error: 'policy_off'
      }
    }
    if (!client) return { ok: false, summary: 'Discord is not connected', error: 'not_connected' }
    const channel = await client.channels.fetch(args.channelId)
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      return { ok: false, summary: `Channel ${args.channelId} is not a postable text channel`, error: 'bad_channel' }
    }
    const sent = await channel.send(args.text.slice(0, 2000))
    return { ok: true, summary: `Posted to Discord channel ${args.channelId}`, data: { messageId: sent.id } }
  } catch (e) {
    return { ok: false, summary: 'discord_post_message failed', error: e instanceof Error ? e.message : String(e) }
  }
}
