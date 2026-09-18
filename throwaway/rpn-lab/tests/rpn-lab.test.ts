/**
 * Acceptance tests for rpn-lab. Written against SPEC.md alone: the lexer, compiler and VM are
 * produced concurrently by other workers, so nothing here may assume behaviour the spec does not
 * state (in particular, no assertions about `RpnError.pos`, which the spec leaves unstated per
 * error site).
 */

import { describe, expect, it } from 'bun:test'
import { compile, evaluate, RpnError, run, tokenize } from '../src/index'
import type { Env, Instr, Token } from '../src/contract'

/**
 * Asserts that `fn` throws an `RpnError` whose message is exactly `message`.
 *
 * Done by hand rather than with `expect().toThrow()` so that both the error class and the full
 * message text are checked exactly — the spec treats message wording as part of the contract, and
 * substring matching would let a wrong-but-similar message through.
 */
function expectRpnError(fn: () => unknown, message: string): void {
  let caught: unknown
  let threw = false
  try {
    fn()
  } catch (error) {
    threw = true
    caught = error
  }
  expect(threw).toBe(true)
  expect(caught).toBeInstanceOf(RpnError)
  expect((caught as RpnError).message).toBe(message)
}

describe('evaluate: arithmetic', () => {
  const cases: Array<[string, number]> = [
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 - 2 - 3', 5],
    ['100 / 5 / 2', 10],
    ['2.5 * 4', 10],
    ['7 % 4', 3],
    ['-7 % 4', -3],
    ['2 ^ 3 ^ 2', 512],
    ['-2 ^ 2', -4],
    ['2 ^ -3', 0.125],
    ['-(3 + 4)', -7],
    ['--3', 3],
  ]

  for (const [source, expected] of cases) {
    it(`evaluates ${source} to ${expected}`, () => {
      expect(evaluate(source)).toBe(expected)
    })
  }
})

describe('evaluate: variables and assignment', () => {
  it('assigns the value of the right-hand side and yields it', () => {
    const env: Env = new Map<string, number>()
    expect(evaluate('x = 3 + 4', env)).toBe(7)
    expect(env.get('x')).toBe(7)
  })

  it('chains assignments right associatively', () => {
    const env: Env = new Map<string, number>()
    expect(evaluate('x = y = 2', env)).toBe(2)
    expect(env.get('x')).toBe(2)
    expect(env.get('y')).toBe(2)
  })

  it('persists bindings across calls that share one Env', () => {
    const env: Env = new Map<string, number>()
    expect(evaluate('x = 2', env)).toBe(2)
    expect(evaluate('x * 5', env)).toBe(10)
  })

  it('treats a parenthesised assignment as an expression', () => {
    const env: Env = new Map<string, number>()
    expect(evaluate('(x = 2) + x', env)).toBe(4)
    expect(env.get('x')).toBe(2)
  })
})

describe('evaluate: errors', () => {
  it('rejects an empty source', () => {
    expectRpnError(() => evaluate(''), 'unexpected end of input')
  })

  it('rejects a missing right-hand operand', () => {
    expectRpnError(() => evaluate('1 +'), 'unexpected end of input')
  })

  it('rejects an unclosed parenthesis', () => {
    expectRpnError(() => evaluate('(1 + 2'), 'unexpected end of input')
  })

  it('rejects a stray assignment operator', () => {
    expectRpnError(() => evaluate('1 + 2 = 3'), "unexpected token '=' at 6")
  })

  it('rejects division by zero', () => {
    expectRpnError(() => evaluate('3 / 0'), 'division by zero')
  })

  it('rejects modulo by zero', () => {
    expectRpnError(() => evaluate('5 % 0'), 'division by zero')
  })

  it('rejects reading an unbound variable', () => {
    expectRpnError(() => evaluate('foo'), "unknown variable 'foo'")
  })

  it('rejects an unexpected character', () => {
    expectRpnError(() => evaluate('1 $ 2'), "unexpected character '$' at 2")
  })
})

describe('tokenize', () => {
  it('tokenizes a mixed expression with 0-based positions', () => {
    const src = 'x = 12.5 + (y)'
    const expected: Token[] = [
      { type: 'ident', text: 'x', pos: 0 },
      { type: 'op', text: '=', pos: 2 },
      { type: 'number', text: '12.5', pos: 4 },
      { type: 'op', text: '+', pos: 9 },
      { type: 'lparen', text: '(', pos: 11 },
      { type: 'ident', text: 'y', pos: 12 },
      { type: 'rparen', text: ')', pos: 13 },
      { type: 'eof', text: '', pos: src.length },
    ]
    expect(tokenize(src)).toEqual(expected)
  })

  it('ends with exactly one eof token positioned at the end of the source', () => {
    const src = '1 + 2'
    const tokens = tokenize(src)
    expect(tokens.filter((token) => token.type === 'eof')).toEqual([
      { type: 'eof', text: '', pos: src.length },
    ])
    expect(tokens[tokens.length - 1]).toEqual({ type: 'eof', text: '', pos: src.length })
  })

  it('yields just an eof token for an empty source', () => {
    expect(tokenize('')).toEqual([{ type: 'eof', text: '', pos: 0 }])
  })

  it('yields just an eof token for all-whitespace source', () => {
    const src = ' \t\r\n '
    expect(tokenize(src)).toEqual([{ type: 'eof', text: '', pos: src.length }])
  })

  it('skips whitespace without disturbing surrounding positions', () => {
    const src = '1\t+\n 2'
    const expected: Token[] = [
      { type: 'number', text: '1', pos: 0 },
      { type: 'op', text: '+', pos: 2 },
      { type: 'number', text: '2', pos: 5 },
      { type: 'eof', text: '', pos: src.length },
    ]
    expect(tokenize(src)).toEqual(expected)
  })
})

describe('compile', () => {
  it('emits a binary operator in postfix order', () => {
    const expected: Instr[] = [{ op: 'push', value: 1 }, { op: 'push', value: 2 }, { op: 'add' }]
    expect(compile(tokenize('1 + 2'))).toEqual(expected)
  })

  it('emits prefix minus as neg after its operand', () => {
    const expected: Instr[] = [{ op: 'load', name: 'x' }, { op: 'neg' }]
    expect(compile(tokenize('-x'))).toEqual(expected)
  })

  it('emits an assignment as a store after its right-hand side', () => {
    const expected: Instr[] = [
      { op: 'push', value: 1 },
      { op: 'push', value: 2 },
      { op: 'add' },
      { op: 'store', name: 'x' },
    ]
    expect(compile(tokenize('x = 1 + 2'))).toEqual(expected)
  })

  it('emits power as pow', () => {
    const expected: Instr[] = [{ op: 'push', value: 2 }, { op: 'push', value: 3 }, { op: 'pow' }]
    expect(compile(tokenize('2 ^ 3'))).toEqual(expected)
  })
})

describe('run', () => {
  it('runs a hand-written program', () => {
    const program: Instr[] = [{ op: 'push', value: 6 }, { op: 'push', value: 7 }, { op: 'mul' }]
    expect(run(program, new Map<string, number>())).toBe(42)
  })

  it('rejects a program that leaves no value on the stack', () => {
    expectRpnError(
      () => run([], new Map<string, number>()),
      'internal error: stack did not reduce to a single value',
    )
  })

  it('rejects a program that leaves more than one value on the stack', () => {
    const program: Instr[] = [{ op: 'push', value: 1 }, { op: 'push', value: 2 }]
    expectRpnError(
      () => run(program, new Map<string, number>()),
      'internal error: stack did not reduce to a single value',
    )
  })

  it('rejects popping from an empty stack', () => {
    expectRpnError(
      () => run([{ op: 'add' }], new Map<string, number>()),
      'internal error: stack underflow',
    )
  })

  it('pushes a stored value back so store is an expression', () => {
    const env: Env = new Map<string, number>()
    const program: Instr[] = [{ op: 'push', value: 5 }, { op: 'store', name: 'a' }]
    expect(run(program, env)).toBe(5)
    expect(env.get('a')).toBe(5)
  })

  it('loads a bound variable from the env', () => {
    const env: Env = new Map<string, number>([['a', 4]])
    expect(run([{ op: 'load', name: 'a' }], env)).toBe(4)
  })

  it('rejects loading an unbound variable', () => {
    expectRpnError(
      () => run([{ op: 'load', name: 'foo' }], new Map<string, number>()),
      "unknown variable 'foo'",
    )
  })
})