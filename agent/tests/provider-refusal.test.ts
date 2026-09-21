import { describe, expect, test } from 'bun:test'
import { describeProviderRefusal } from '../src/main/openrouter/client'

/**
 * Regression cover for a bug found while running live cache probes: a prompt that tripped
 * Anthropic's content filter streamed `delta.refusal` + `finish_reason: content_filter` and no
 * usage chunk. Because `refusal` was ignored, the turn looked like an empty generation, retried
 * MAX_TRUNCATION_RETRIES times (each retry guaranteed to be refused again, since the prompt is
 * what's blocked) and reported a misleading "provider-side problem" message.
 */
describe('describeProviderRefusal', () => {
  test('reports the provider\'s verbatim reason when nothing usable was produced', () => {
    const msg = describeProviderRefusal({
      refusal: "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering",
      finishReason: 'content_filter',
      hasText: false,
      hasToolCalls: false
    })
    expect(msg).toBeTruthy()
    // The verbatim reason is the whole value of the fix — a generic message would leave the user
    // guessing at exactly the moment the provider told us why.
    expect(msg).toContain('violate Anthropic')
    expect(msg).toContain('retrying will not help')
  })

  test('a content_filter stop with no reason text still reports, without inventing a quote', () => {
    const msg = describeProviderRefusal({
      refusal: undefined,
      finishReason: 'content_filter',
      hasText: false,
      hasToolCalls: false
    })
    expect(msg).toBeTruthy()
    expect(msg).toContain('content filter')
    expect(msg).not.toContain('Reason given')
  })

  test('whitespace-only refusal text falls back to the generic message', () => {
    const msg = describeProviderRefusal({
      refusal: '   \n ',
      finishReason: 'content_filter',
      hasText: false,
      hasToolCalls: false
    })
    expect(msg).toBeTruthy()
    expect(msg).not.toContain('Reason given')
  })

  test('never clobbers a real answer: text already streamed means no refusal error', () => {
    expect(
      describeProviderRefusal({ refusal: 'partial policy note', finishReason: 'content_filter', hasText: true, hasToolCalls: false })
    ).toBeNull()
  })

  test('never clobbers tool calls either', () => {
    expect(
      describeProviderRefusal({ refusal: 'partial policy note', finishReason: 'stop', hasText: false, hasToolCalls: true })
    ).toBeNull()
  })

  test('an ordinary empty generation is NOT reported as a refusal', () => {
    // Negative control: this shape must keep falling through to isEmptyGeneration's retry path,
    // which is the correct handling for a genuinely empty generation.
    expect(
      describeProviderRefusal({ refusal: undefined, finishReason: 'stop', hasText: false, hasToolCalls: false })
    ).toBeNull()
    expect(
      describeProviderRefusal({ refusal: undefined, finishReason: undefined, hasText: false, hasToolCalls: false })
    ).toBeNull()
  })
})
