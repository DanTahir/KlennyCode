/**
 * Shared contract for rpn-lab. Every other module in this project imports its types from here and
 * nowhere else, which is what lets the lexer, compiler, VM and test suite be written independently
 * (and concurrently) against one another without ever seeing each other's source.
 *
 * See SPEC.md for the semantics these types describe. This file is deliberately types-and-errors
 * only: it must stay free of behaviour so that no two modules can disagree about it.
 */

export type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'eof'

export interface Token {
  type: TokenType
  /** the exact source text of this token; `''` for `eof` */
  text: string
  /** 0-based index of the token's first character; `src.length` for `eof` */
  pos: number
}

/** Stack-machine instruction. Emitted in postfix order by the compiler, consumed by the VM. */
export type Instr =
  | { op: 'push'; value: number }
  | { op: 'load'; name: string }
  | { op: 'store'; name: string }
  | { op: 'add' }
  | { op: 'sub' }
  | { op: 'mul' }
  | { op: 'div' }
  | { op: 'mod' }
  | { op: 'pow' }
  | { op: 'neg' }

/** Variable bindings. Owned by the caller and mutated in place by `store`, so assignments persist
 *  across evaluations that share one Env. */
export type Env = Map<string, number>

/**
 * The only error type this project throws, from any stage. `pos` is set when the failure can be
 * attributed to a source position (lexer, compiler) and omitted when it cannot (VM errors, and
 * `unexpected end of input`).
 */
export class RpnError extends Error {
  readonly pos?: number

  constructor(message: string, pos?: number) {
    super(message)
    this.name = 'RpnError'
    this.pos = pos
  }
}

/**
 * Module signatures the independent workers must match exactly:
 *
 *   src/lexer.ts     export function tokenize(src: string): Token[]
 *   src/compiler.ts  export function compile(tokens: Token[]): Instr[]
 *   src/vm.ts        export function run(program: Instr[], env: Env): number
 */
