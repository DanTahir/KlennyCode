/**
 * Gmail integration (Phase 2 of the Personal Assistant Platform plan).
 *
 * Auth: user registers their own Google Cloud OAuth client (Client ID/Secret, stored in
 * settings.json) and connects via a loopback authorization-code flow — Klenny opens the
 * system browser to Google's consent screen, runs a short-lived local HTTP server on an
 * auto-selected free port to catch the redirect + code, and exchanges it for tokens using
 * `google-auth-library` (bundled with `googleapis`). Tokens are stored encrypted via the same
 * safeStorage + *.enc pattern as the existing OpenRouter API key (see settings.ts).
 *
 * Reads use the minimal `gmail.readonly` scope; sending uses `gmail.send` — never full mailbox
 * modify/delete access.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { shell } from 'electron'
import { google } from 'googleapis'
import type { ToolResultPayload } from '@shared/types'
import {
  getGmailToken,
  setGmailToken,
  clearGmailToken,
  loadSettings,
  saveSettings,
  type GmailTokenBlob
} from '../settings'

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']

async function makeOAuthClient() {
  const settings = await loadSettings()
  if (!settings.gmailClientId || !settings.gmailClientSecret) {
    throw new Error('Gmail Client ID/Secret are not set. Add them in Settings \u2192 Integrations \u2192 Gmail first.')
  }
  return { settings, clientId: settings.gmailClientId, clientSecret: settings.gmailClientSecret }
}

/** Runs the full loopback OAuth flow and stores the resulting tokens encrypted. Resolves with
 *  the connected account's email address, or throws a user-facing error message. */
export async function connectGmail(): Promise<{ email: string }> {
  const { clientId, clientSecret } = await makeOAuthClient()

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'Content-Type': 'text/html' })
        if (error || !code) {
          res.end('<html><body>Gmail connection failed or was cancelled. You can close this tab.</body></html>')
          server.close()
          reject(new Error(error ?? 'No authorization code returned by Google.'))
          return
        }
        res.end('<html><body>Gmail connected \u2014 you can close this tab and return to Klenny Code.</body></html>')
        const port = (server.address() as AddressInfo).port
        server.close()
        resolve({ code, redirectUri: `http://127.0.0.1:${port}/oauth/callback` })
      } catch (e) {
        server.close()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    server.on('error', (e) => reject(e))
    // Port 0 = let the OS pick a free port, avoiding EADDRINUSE conflicts with other apps.
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES
      })
      void shell.openExternal(authUrl)
    })
  })

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  const { tokens } = await oauth2Client.getToken(code)
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. If you have connected before, revoke access at https://myaccount.google.com/permissions and try again.'
    )
  }
  oauth2Client.setCredentials(tokens)

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
  const profile = await gmail.users.getProfile({ userId: 'me' })
  const email = profile.data.emailAddress ?? 'unknown'

  await setGmailToken(tokens as GmailTokenBlob)
  await saveSettings({ gmailAccountEmail: email, lastGmailRefreshError: null })
  return { email }
}

export async function disconnectGmail(): Promise<void> {
  await clearGmailToken()
  await saveSettings({ gmailAccountEmail: null, lastGmailRefreshError: null })
}

/** Builds an authenticated Gmail client, transparently refreshing the access token via the
 *  stored refresh token. On refresh failure (revoked/expired), clears the stored token and
 *  records a user-facing error in settings so Settings UI / scheduled-task run history can
 *  surface a "Reconnect Gmail" prompt instead of failing silently. */
async function getGmailClient() {
  const { clientId, clientSecret } = await makeOAuthClient()
  const token = await getGmailToken()
  if (!token) throw new Error('Gmail is not connected. Connect it in Settings \u2192 Integrations first.')

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
  // googleapis' Credentials type declares scope as `string | undefined` (no null), but a
  // round-tripped-through-JSON token blob can legitimately have `scope: null` — cast rather
  // than fight the upstream type here.
  oauth2Client.setCredentials(token as Parameters<typeof oauth2Client.setCredentials>[0])
  oauth2Client.on('tokens', (fresh) => {
    void setGmailToken({ ...token, ...fresh })
  })

  try {
    await oauth2Client.getAccessToken()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await clearGmailToken()
    await saveSettings({ gmailAccountEmail: null, lastGmailRefreshError: message })
    throw new Error(`Gmail token refresh failed (${message}). Reconnect Gmail in Settings \u2192 Integrations.`)
  }

  return google.gmail({ version: 'v1', auth: oauth2Client })
}

function checkPolicy(allowed: boolean, action: string): void {
  if (!allowed) {
    throw new Error(
      `"${action}" is disabled by your Automation Permissions settings. Enable it in Settings \u2192 Integrations \u2192 Automation Permissions if you want the agent to do this.`
    )
  }
}

export async function gmailListMessagesTool(args: { query?: string; maxResults?: number }): Promise<ToolResultPayload> {
  try {
    const settings = await loadSettings()
    checkPolicy(settings.automationPermissions['gmail.read'] === 'auto', 'gmail.read')
    const gmail = await getGmailClient()
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: args.query,
      maxResults: Math.min(args.maxResults ?? 10, 25)
    })
    const messages = res.data.messages ?? []
    return { ok: true, summary: `Found ${messages.length} message(s)`, data: { messages } }
  } catch (e) {
    return { ok: false, summary: 'gmail_list_messages failed', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function gmailGetMessageTool(args: { id: string }): Promise<ToolResultPayload> {
  try {
    const settings = await loadSettings()
    checkPolicy(settings.automationPermissions['gmail.read'] === 'auto', 'gmail.read')
    const gmail = await getGmailClient()
    const res = await gmail.users.messages.get({ userId: 'me', id: args.id, format: 'full' })
    const headers = res.data.payload?.headers ?? []
    const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value
    const snippet = res.data.snippet ?? ''
    return {
      ok: true,
      summary: `Subject: ${get('subject') ?? '(no subject)'}`,
      data: {
        id: res.data.id,
        threadId: res.data.threadId,
        from: get('from'),
        to: get('to'),
        subject: get('subject'),
        date: get('date'),
        snippet
      }
    }
  } catch (e) {
    return { ok: false, summary: 'gmail_get_message failed', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function gmailSendMessageTool(args: { to: string; subject: string; body: string }): Promise<ToolResultPayload> {
  try {
    const settings = await loadSettings()
    checkPolicy(settings.automationPermissions['gmail.send'] === 'auto', 'gmail.send')
    const gmail = await getGmailClient()
    const raw = Buffer.from(
      `To: ${args.to}\r\nSubject: ${args.subject}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${args.body}`
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
    return { ok: true, summary: `Sent email to ${args.to}`, data: { id: res.data.id } }
  } catch (e) {
    return { ok: false, summary: 'gmail_send_message failed', error: e instanceof Error ? e.message : String(e) }
  }
}
