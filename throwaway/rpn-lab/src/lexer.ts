/**
 * Lexer: source text -> flat token list.
 *
 * A single forward scan with an explicit cursor; every token records the index of its first
 * character so the compiler can quote positions in its own error messages. Trailing `eof` is
 * always emitted (even for empty input) so the parser never has to bounds-check its lookahead.
 */

import type { Token, TokenType } from './contract'
import { RpnError } from './contract'

const OPERATORS = '+-*/%^='

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\r' || c === '\n'
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

function isIdentStart(c: string): boolean {
  return c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c)
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < src.length) {
    const c = src[i]

    if (isWhitespace(c)) {
      i += 1
      continue
    }

    if (isDigit(c)) {
      const start = i
      while (i < src.length && isDigit(src[i])) i += 1
      // A fractional part only counts when a digit actually follows the dot, so `1.` lexes as the
      // number `1` followed by an unexpected-character error on the dot.
      if (i < src.length && src[i] === '.' && i + 1 < src.length && isDigit(src[i + 1])) {
        i += 1
        while (i < src.length && isDigit(src[i])) i += 1
      }
      tokens.push({ type: 'number', text: src.slice(start, i), pos: start })
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      while (i < src.length && isIdentPart(src[i])) i += 1
      tokens.push({ type: 'ident', text: src.slice(start, i), pos: start })
      continue
    }

    if (OPERATORS.includes(c)) {
      tokens.push({ type: 'op', text: c, pos: i })
      i += 1
      continue
    }

    if (c === '(' || c === ')') {
      const type: TokenType = c === '(' ? 'lparen' : 'rparen'
      tokens.push({ type, text: c, pos: i })
      i += 1
      continue
    }

    throw new RpnError(`unexpected character '${c}' at ${i}`, i)
  }

  tokens.push({ type: 'eof', text: '', pos: src.length })
  return tokens
}