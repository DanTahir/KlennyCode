# rpn-lab — mini expression language (throwaway test project)

A tiny expression language toolchain: **source text → tokens → stack-machine instructions →
number**. It exists to exercise `parallel_write`: the three implementation modules and the test
suite are written by four *independent* workers that can see this spec and `src/contract.ts`, but
not each other's output. If they all conform to this document, the pipeline composes and the tests
pass.

This document is the single source of truth. Where it is explicit, it is not negotiable: exact
error message text is part of the contract because a blind test author asserts on it.

## Module layout and ownership

| File | Exports | Written by |
| --- | --- | --- |
| `src/contract.ts` | types, `RpnError` | coordinated (pre-written) |
| `src/index.ts` | `evaluate` | coordinated (pre-written) |
| `src/lexer.ts` | `tokenize(src: string): Token[]` | worker A |
| `src/compiler.ts` | `compile(tokens: Token[]): Instr[]` | worker B |
| `src/vm.ts` | `run(program: Instr[], env: Env): number` | worker C |
| `tests/rpn-lab.test.ts` | — | worker D |

Every module imports its types from `./contract` (tests: `../src/contract`) and imports nothing
else — no third-party packages, no Node built-ins.

## Lexical rules (`tokenize`)

Positions (`pos`) are **0-based indices into the source string**, pointing at the token's first
character.

- Whitespace (space, tab, CR, LF) separates tokens and is otherwise ignored.
- **number** — `[0-9]+(\.[0-9]+)?`. `text` is the matched substring. No exponent notation, no
  leading-dot form: `.5` is an error (`.` is not a valid token start).
- **ident** — `[A-Za-z_][A-Za-z0-9_]*`.
- **op** — exactly one of `+ - * / % ^ =`; `text` is that single character.
- **lparen** — `(` . **rparen** — `)` . `text` is the character.
- Any other character throws `RpnError` with message:
  `unexpected character '$' at 2` (the offending character in single quotes, then its index).
- The returned array always ends with exactly one `eof` token: `text` is `''` and `pos` is
  `src.length`. An empty or all-whitespace source yields just that `eof` token.

## Grammar (`compile`)

Precedence, lowest binding first:

1. **assignment** `=` — right associative, target must be a bare identifier
2. **additive** `+ -` — left associative
3. **multiplicative** `* / %` — left associative
4. **unary minus** `-` — prefix, may repeat (`--3` is `3`)
5. **power** `^` — right associative, binds *tighter* than unary minus

```
expr     := assign
assign   := ident '=' assign | additive          // only when the next two tokens are ident, '='
additive := multiplicative (('+' | '-') multiplicative)*
multiplicative := unary (('*' | '/' | '%') unary)*
unary    := '-' unary | power
power    := primary ('^' unary)?                 // exponent is a unary, giving right associativity
primary  := number | ident | '(' expr ')'
```

Consequences worth stating outright, because they are the interesting cases:

- `-2 ^ 2` is `-(2 ^ 2)` = `-4` (power binds tighter than unary minus).
- `2 ^ -3` is legal and equals `0.125` (the exponent is a `unary`).
- `2 ^ 3 ^ 2` is `2 ^ (3 ^ 2)` = `512`.
- `x = y = 2` assigns `2` to both; assignment is an expression yielding the assigned value.

Assignment is recognised by **two-token lookahead**: an `ident` whose immediately following token
is an `op` with text `=`. Anything else falls through to `additive`, so `(x) = 3` and `1 + 2 = 3`
both fail as a stray `=` token rather than as a special "bad assignment target" case.

`compile` must consume the entire token stream and require the `eof` token at the end.

### Compiler errors

- An unexpected token: `unexpected token '=' at 6` — `text` in single quotes, then its `pos`.
- Hitting `eof` where a `primary` or a right-hand side was required:
  `unexpected end of input` (no position suffix).

## Instruction emission

Instructions are emitted in postfix (stack) order. For a binary operator, the left operand's
instructions come first, then the right operand's, then the operator.

| Source | Program |
| --- | --- |
| `1 + 2` | `push 1`, `push 2`, `add` |
| `-x` | `load x`, `neg` |
| `x = 1 + 2` | `push 1`, `push 2`, `add`, `store x` |
| `2 ^ 3` | `push 2`, `push 3`, `pow` |

Operator → instruction: `+`→`add`, `-`→`sub`, `*`→`mul`, `/`→`div`, `%`→`mod`, `^`→`pow`,
prefix `-`→`neg`.

## VM semantics (`run`)

A number stack, evaluated left to right. `env` is read *and written* in place (the caller owns it,
so assignments persist across calls that share one `Env`).

- `push value` — pushes `value`.
- `load name` — pushes `env.get(name)`; if the name is absent throws `RpnError`
  `unknown variable 'foo'`.
- `store name` — pops one value, sets `env.set(name, value)`, and **pushes that value back** (so
  assignment is an expression).
- `add` / `sub` / `mul` / `div` / `mod` / `pow` — pop the right operand, then the left; push the
  result. `div` and `mod` throw `RpnError` `division by zero` when the right operand is exactly
  `0`. `pow` is `Math.pow`, `mod` is JavaScript's `%` (sign follows the left operand).
- `neg` — pops one value, pushes its negation.
- Popping from an empty stack throws `RpnError` `internal error: stack underflow`.
- After the last instruction the stack must hold exactly one value, which is the result;
  otherwise throw `RpnError` `internal error: stack did not reduce to a single value`.

## Worked examples (the acceptance table)

`evaluate(source)` with a fresh empty `Env` unless stated otherwise.

| Source | Result |
| --- | --- |
| `1 + 2 * 3` | `7` |
| `(1 + 2) * 3` | `9` |
| `10 - 2 - 3` | `5` |
| `100 / 5 / 2` | `10` |
| `2.5 * 4` | `10` |
| `7 % 4` | `3` |
| `-7 % 4` | `-3` |
| `2 ^ 3 ^ 2` | `512` |
| `-2 ^ 2` | `-4` |
| `2 ^ -3` | `0.125` |
| `-(3 + 4)` | `-7` |
| `--3` | `3` |
| `x = 3 + 4` | `7`, and `env.get('x') === 7` |
| `x = y = 2` | `2`, and both `x` and `y` are `2` |
| `x = 2` then `x * 5` on the same `Env` | `10` |
| `(x = 2) + x` | `4` |
| `` (empty string) | throws `unexpected end of input` |
| `1 +` | throws `unexpected end of input` |
| `1 + 2 = 3` | throws `unexpected token '=' at 6` |
| `(1 + 2` | throws `unexpected end of input` |
| `3 / 0` | throws `division by zero` |
| `5 % 0` | throws `division by zero` |
| `foo` | throws `unknown variable 'foo'` |
| `1 $ 2` | throws `unexpected character '$' at 2` |

All thrown errors are instances of `RpnError`.
