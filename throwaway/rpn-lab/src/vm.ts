/**
 * Stack virtual machine for rpn-lab. Executes the postfix instruction stream produced by the
 * compiler against a caller-owned `Env`.
 *
 * See SPEC.md, "VM semantics (`run`)".
 */

import type { Env, Instr } from './contract'
import { RpnError } from './contract'

export function run(program: Instr[], env: Env): number {
  const stack: number[] = []

  /** Pops one value, or fails loudly: an underflow means the compiler emitted a bad program. */
  function pop(): number {
    const value = stack.pop()
    if (value === undefined) {
      throw new RpnError('internal error: stack underflow')
    }
    return value
  }

  for (const instr of program) {
    switch (instr.op) {
      case 'push':
        stack.push(instr.value)
        break
      case 'load': {
        // `has` rather than an undefined check: absence is the error, and a Map<string, number>
        // cannot hold undefined as a value anyway.
        if (!env.has(instr.name)) {
          throw new RpnError(`unknown variable '${instr.name}'`)
        }
        // The `?? 0` is unreachable; it exists only because the type checker cannot see that the
        // `has` guard above guarantees a binding.
        stack.push(env.get(instr.name) ?? 0)
        break
      }
      case 'store': {
        // Mutates the caller's Env in place so assignments persist across evaluations, and pushes
        // the value back so that assignment is an expression.
        const value = pop()
        env.set(instr.name, value)
        stack.push(value)
        break
      }
      case 'add': {
        // Binary operators pop the right operand first: the compiler emitted left, then right.
        const right = pop()
        const left = pop()
        stack.push(left + right)
        break
      }
      case 'sub': {
        const right = pop()
        const left = pop()
        stack.push(left - right)
        break
      }
      case 'mul': {
        const right = pop()
        const left = pop()
        stack.push(left * right)
        break
      }
      case 'div': {
        const right = pop()
        const left = pop()
        if (right === 0) {
          throw new RpnError('division by zero')
        }
        stack.push(left / right)
        break
      }
      case 'mod': {
        const right = pop()
        const left = pop()
        if (right === 0) {
          throw new RpnError('division by zero')
        }
        // JavaScript `%`: the sign follows the left operand, so `-7 % 4` is -3.
        stack.push(left % right)
        break
      }
      case 'pow': {
        const right = pop()
        const left = pop()
        stack.push(Math.pow(left, right))
        break
      }
      case 'neg':
        stack.push(-pop())
        break
      default: {
        // Exhaustiveness check: if a new Instr variant is added, this assignment stops compiling.
        const unreachable: never = instr
        throw new RpnError(`internal error: unknown instruction ${String(unreachable)}`)
      }
    }
  }

  // An empty program lands here too, which is why this check is not phrased as an underflow.
  if (stack.length !== 1) {
    throw new RpnError('internal error: stack did not reduce to a single value')
  }
  return pop()
}