/**
 * Pipeline glue: source text -> tokens -> instructions -> number.
 *
 * Coordinated by hand (not by a parallel worker) precisely because it is the one file that depends
 * on all three implementation modules at once.
 */

import type { Env, Instr, Token } from './contract'
import { tokenize } from './lexer'
import { compile } from './compiler'
import { run } from './vm'

export type { Env, Instr, Token } from './contract'
export { RpnError } from './contract'
export { tokenize } from './lexer'
export { compile } from './compiler'
export { run } from './vm'

/**
 * Evaluates one expression.
 *
 * `env` is mutated in place by assignments, so passing the same Env to successive calls makes
 * variables persist — `evaluate('x = 2', env)` then `evaluate('x * 5', env)` yields 10.
 */
export function evaluate(src: string, env: Env = new Map<string, number>()): number {
  return run(compile(tokenize(src)), env)
}
