import type { ModelInfo } from '@shared/types'
import { CURATED_MODEL_IDS } from '@shared/types'

const BASE = 'https://openrouter.ai/api/v1'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

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

export interface StreamChunk {
  type: 'text' | 'reasoning' | 'tool_calls' | 'usage' | 'done' | 'error'
  text?: string
  toolCalls?: ToolCall[]
  usage?: { promptTokens: number; completionTokens: number; costUsd: number }
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
    const pricing = (m.pricing as { prompt?: string; completion?: string }) ?? {}
    const supported = (m.supported_parameters as string[]) ?? []
    return {
      id,
      name: String(m.name ?? id),
      contextLength: Number(m.context_length ?? 128_000),
      promptPrice: Number(pricing.prompt ?? 0),
      completionPrice: Number(pricing.completion ?? 0),
      supportsTools: supported.includes('tools'),
      supportsReasoning: supported.includes('reasoning') || supported.includes('include_reasoning'),
      supportsVision: ((m.architecture as { input_modalities?: string[] })?.input_modalities ?? []).includes('image'),
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
  includeReasoning?: boolean
}): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  if (opts.includeReasoning) body.include_reasoning = true

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
          'X-Title': 'Klenny'
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
                  costUsd: parsed.usage.cost ?? 0
                }
              }
            }

            if (parsed.choices?.[0]?.finish_reason === 'tool_calls' && toolCalls.size) {
              yield { type: 'tool_calls', toolCalls: [...toolCalls.values()] }
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

export async function summarizeMessages(apiKey: string, model: string, text: string, signal?: AbortSignal): Promise<string> {
  let out = ''
  for await (const chunk of streamChatCompletion({
    apiKey,
    model,
    messages: [
      {
        role: 'system',
        content: 'Summarize the following conversation history concisely, preserving key decisions, file paths, and open tasks.'
      },
      { role: 'user', content: text }
    ],
    signal
  })) {
    if (chunk.type === 'text' && chunk.text) out += chunk.text
    if (chunk.type === 'error') throw new Error(chunk.error)
  }
  return out.trim()
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
