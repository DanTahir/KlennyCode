import type { ModelInfo, ProviderPreference } from '@shared/types'
import { CURATED_MODEL_IDS } from '@shared/types'
import { applyCacheControl, isExplicitCacheFamily } from './caching'

const BASE = 'https://openrouter.ai/api/v1'

export interface CacheControl {
  type: 'ephemeral'
}

export type ContentPart =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image_url'; image_url: { url: string }; cache_control?: CacheControl }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface UsageChunk {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface StreamChunk {
  type: 'text' | 'reasoning' | 'tool_calls' | 'usage' | 'done' | 'error'
  text?: string
  toolCalls?: ToolCall[]
  usage?: UsageChunk
  error?: string
}

let modelsCache: ModelInfo[] | null = null
let modelsCacheAt = 0

export async function fetchModels(apiKey: string, force = false, signal?: AbortSignal): Promise<ModelInfo[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (!force && modelsCache && Date.now() - modelsCacheAt < 5 * 60_000) return modelsCache

  const res = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  })
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`)
  const json = (await res.json()) as { data: Array<Record<string, unknown>> }

  modelsCache = json.data.map((m) => {
    const id = String(m.id)
    const pricing = (m.pricing as { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string }) ?? {}
    const supported = (m.supported_parameters as string[]) ?? []
    const reasoningMeta = m.reasoning as { supported_efforts?: string[]; mandatory?: boolean } | undefined
    return {
      id,
      name: String(m.name ?? id),
      contextLength: Number(m.context_length ?? 128_000),
      promptPrice: Number(pricing.prompt ?? 0),
      completionPrice: Number(pricing.completion ?? 0),
      cacheReadPrice: pricing.input_cache_read != null ? Number(pricing.input_cache_read) : null,
      cacheWritePrice: pricing.input_cache_write != null ? Number(pricing.input_cache_write) : null,
      supportsExplicitCaching: isExplicitCacheFamily(id),
      supportsTools: supported.includes('tools'),
      supportsReasoning: supported.includes('reasoning') || supported.includes('include_reasoning'),
      supportsVision: ((m.architecture as { input_modalities?: string[] })?.input_modalities ?? []).includes('image'),
      supportsEmbeddings: ((m.architecture as { output_modalities?: string[] })?.output_modalities ?? []).includes(
        'embeddings'
      ),
      supportedReasoningEfforts: reasoningMeta?.supported_efforts,
      reasoningMandatory: reasoningMeta?.mandatory,
      pinned: CURATED_MODEL_IDS.includes(id)
    } satisfies ModelInfo
  })

  modelsCache.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return a.name.localeCompare(b.name)
  })

  modelsCacheAt = Date.now()
  return modelsCache
}

export async function* streamChatCompletion(opts: {
  apiKey: string
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  signal?: AbortSignal
  /** granular effort level to request (only sent when the model's supportedReasoningEfforts includes it — see callers) */
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** fallback for models that support reasoning but not granular effort control — preserves the old "always on when supported" behavior */
  reasoningEnabledOnly?: boolean
  /** stable key for OpenRouter provider sticky-routing, keeps prompt caches warm across turns */
  sessionId?: string
  /** advanced: force/restrict specific upstream providers (see @shared/types ProviderPreference) */
  providerPreference?: ProviderPreference
  /** true when this model family (Anthropic/Qwen/DeepSeek-v3.2) needs explicit cache_control markers */
  supportsExplicitCaching?: boolean
  /** skip the "last message" cache breakpoint on the very first request of a conversation (nothing to read back yet) */
  includeLastMessageCacheBreakpoint?: boolean
}): AsyncGenerator<StreamChunk> {
  const messages = applyCacheControl(
    opts.messages,
    Boolean(opts.supportsExplicitCaching),
    opts.includeLastMessageCacheBreakpoint ?? true
  )
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  // 3-way: models with granular effort control get `reasoning.effort`; models that support
  // reasoning but not effort levels (common for Anthropic/Gemini families) get `enabled: true`
  // to preserve the previous "always on when supported" behavior; models without reasoning
  // support get nothing at all.
  if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort }
  else if (opts.reasoningEnabledOnly) body.reasoning = { enabled: true }
  if (opts.sessionId) body.session_id = opts.sessionId
  if (opts.providerPreference && (opts.providerPreference.only?.length || opts.providerPreference.order?.length)) {
    const provider: Record<string, unknown> = {}
    if (opts.providerPreference.only?.length) provider.only = opts.providerPreference.only
    if (opts.providerPreference.order?.length) provider.order = opts.providerPreference.order
    body.provider = provider
  }

  let attempt = 0
  while (attempt < 4) {
    attempt++
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/DanTahir/KlennyCode',
          'X-Title': 'Klenny Code'
        },
        body: JSON.stringify(body),
        signal: opts.signal
      })

      if (res.status === 429 || res.status >= 500) {
        if (attempt < 4) {
          await abortableSleep(500 * 2 ** attempt, opts.signal)
          continue
        }
        yield { type: 'error', error: `OpenRouter error ${res.status}` }
        return
      }

      if (!res.ok) {
        const errText = await res.text()
        yield { type: 'error', error: errText || `HTTP ${res.status}` }
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        yield { type: 'error', error: 'No response body' }
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''
      const toolCalls: Map<number, ToolCall> = new Map()

      while (true) {
        if (opts.signal?.aborted) {
          await reader.cancel().catch(() => {})
          return
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            if (toolCalls.size) yield { type: 'tool_calls', toolCalls: [...toolCalls.values()] }
            yield { type: 'done' }
            return
          }
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string
                  reasoning?: string
                  tool_calls?: Array<{
                    index: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
                finish_reason?: string
              }>
              usage?: {
                prompt_tokens?: number
                completion_tokens?: number
                cost?: number
                prompt_tokens_details?: {
                  cached_tokens?: number
                  cache_write_tokens?: number
                }
              }
            }

            const delta = parsed.choices?.[0]?.delta
            if (delta?.reasoning) yield { type: 'reasoning', text: delta.reasoning }
            if (delta?.content) yield { type: 'text', text: delta.content }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCalls.get(tc.index) ?? {
                  id: tc.id ?? `call_${tc.index}`,
                  type: 'function' as const,
                  function: { name: '', arguments: '' }
                }
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.function.name += tc.function.name
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
                toolCalls.set(tc.index, existing)
              }
            }

            if (parsed.usage) {
              yield {
                type: 'usage',
                usage: {
                  promptTokens: parsed.usage.prompt_tokens ?? 0,
                  completionTokens: parsed.usage.completion_tokens ?? 0,
                  cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
                  cacheWriteTokens: parsed.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
                  costUsd: parsed.usage.cost ?? 0
                }
              }
            }
          } catch {
            // skip malformed SSE chunks
          }
        }
      }

      if (toolCalls.size) yield { type: 'tool_calls', toolCalls: [...toolCalls.values()] }
      yield { type: 'done' }
      return
    } catch (e) {
      if (opts.signal?.aborted) return
      if (attempt < 4) {
        await abortableSleep(500 * 2 ** attempt, opts.signal)
        continue
      }
      yield { type: 'error', error: e instanceof Error ? e.message : String(e) }
      return
    }
  }
}

export async function summarizeMessages(
  apiKey: string,
  model: string,
  text: string,
  signal?: AbortSignal,
  supportsExplicitCaching?: boolean
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Summarize the following conversation history concisely, preserving key decisions, file paths, and open tasks.'
    },
    { role: 'user', content: text }
  ]

  let out = ''
  for await (const chunk of streamChatCompletion({
    apiKey,
    model,
    messages,
    signal,
    supportsExplicitCaching,
    // The transcript (last message) is unique per call — only cache the static system instruction, never the transcript.
    includeLastMessageCacheBreakpoint: false
  })) {
    if (chunk.type === 'text' && chunk.text) out += chunk.text
    if (chunk.type === 'error') throw new Error(chunk.error)
  }
  return out.trim()
}

export interface EmbeddingsResult {
  embeddings: number[][]
  /** input tokens billed for this request, used to roll embeddings cost into spend tracking */
  promptTokens: number
}

/**
 * Calls OpenRouter's dedicated /embeddings endpoint (separate from /chat/completions —
 * no streaming, deterministic output, supports batch input). Reuses the same OpenRouter
 * API key as chat completions; no separate embeddings provider key needed.
 */
export async function createEmbeddings(
  apiKey: string,
  model: string,
  input: string[],
  signal?: AbortSignal
): Promise<EmbeddingsResult> {
  const res = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/DanTahir/KlennyCode',
      'X-Title': 'Klenny Code'
    },
    body: JSON.stringify({ model, input }),
    signal
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Embeddings request failed: ${res.status}${errText ? ` — ${errText}` : ''}`)
  }
  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>
    usage?: { prompt_tokens?: number; total_tokens?: number }
  }
  const sorted = [...json.data].sort((a, b) => a.index - b.index)
  return {
    embeddings: sorted.map((d) => d.embedding),
    promptTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}
