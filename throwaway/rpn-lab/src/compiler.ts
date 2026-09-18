/**
 * Recursive-descent compiler: tokens -> stack-machine instructions in postfix order.
 *
 * The grammar (see SPEC.md) is encoded one function per precedence level, lowest binding first.
 * Two decisions are worth spelling out because they are not obvious from the code shape:
 *
 *  - `power` parses its exponent as a `unary`, not as a `power`. That single choice gives both
 *    right associativity (`2 ^ 3 ^ 2` is `2 ^ (3 ^ 2)`) and a legal `2 ^ -3`, while still letting
 *    `^` bind tighter than prefix `-` (so `-2 ^ 2` is `-(2 ^ 2)`).
 *  - assignment is recognised purely by two-token lookahead (`ident` followed by `op` `=`). There
 *    is deliberately no "invalid assignment target" diagnostic: anything else falls through to
 *    `additive`, so `(x) = 3` and `1 + 2 = 3` fail later on the stray `=` token.
 */

import type { Instr, Token } from './contract'
import { RpnError } from './contract'

/** Binary source operator -> instruction opcode. */
const BINARY_OPS: Record<string, Instr['op']> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'mod',
  '^': 'pow',
}

export function compile(tokens: Token[]): Instr[] {
  const out: Instr[] = []
  let index = 0

  function peek(offset = 0): Token | undefined {
    return tokens[index + offset]
  }

  /** The token at the cursor. Absent only if the caller was handed a stream without `eof`. */
  function current(): Token {
    const token = peek()
    if (token === undefined) throw new RpnError('unexpected end of input')
    return token
  }

  function advance(): Token {
    const token = current()
    index += 1
    return token
  }

  function isOp(token: Token | undefined, ...texts: string[]): boolean {
    return token !== undefined && token.type === 'op' && texts.includes(token.text)
  }

  function unexpected(token: Token): RpnError {
    if (token.type === 'eof') return new RpnError('unexpected end of input')
    return new RpnError(`unexpected token '${token.text}' at ${token.pos}`, token.pos)
  }

  function emit(instr: Instr): void {
    out.push(instr)
  }

  function parseExpr(): void {
    parseAssign()
  }

  function parseAssign(): void {
    const target = peek()
    if (target !== undefined && target.type === 'ident' && isOp(peek(1), '=')) {
      advance() // ident
      advance() // '='
      parseAssign() // right associative: `x = y = 2` assigns 2 to both
      emit({ op: 'store', name: target.text })
      return
    }
    parseAdditive()
  }

  function parseAdditive(): void {
    parseMultiplicative()
    while (isOp(peek(), '+', '-')) {
      const operator = advance()
      parseMultiplicative()
      emit({ op: BINARY_OPS[operator.text] } as Instr)
    }
  }

  function parseMultiplicative(): void {
    parseUnary()
    while (isOp(peek(), '*', '/', '%')) {
      const operator = advance()
      parseUnary()
      emit({ op: BINARY_OPS[operator.text] } as Instr)
    }
  }

  function parseUnary(): void {
    if (isOp(peek(), '-')) {
      advance()
      parseUnary() // prefix minus may repeat: `--3` is `3`
      emit({ op: 'neg' })
      return
    }
    parsePower()
  }

  function parsePower(): void {
    parsePrimary()
    if (isOp(peek(), '^')) {
      advance()
      parseUnary()
      emit({ op: 'pow' })
    }
  }

  function parsePrimary(): void {
    const token = current()
    if (token.type === 'number') {
      advance()
      emit({ op: 'push', value: Number(token.text) })
      return
    }
    if (token.type === 'ident') {
      advance()
      emit({ op: 'load', name: token.text })
      return
    }
    if (token.type === 'lparen') {
      advance()
      parseExpr()
      const closing = current()
      if (closing.type !== 'rparen') throw unexpected(closing)
      advance()
      return
    }
    throw unexpected(token)
  }

  parseExpr()

  const trailing = current()
  if (trailing.type !== 'eof') throw unexpected(trailing)

  return out
}