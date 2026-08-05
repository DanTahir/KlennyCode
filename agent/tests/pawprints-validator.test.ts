import { describe, expect, test } from 'bun:test'
import { validatePawprintSource, PAWPRINT_SDK_MODULE } from '../src/main/agent/pawprints/validator'

describe('validatePawprintSource', () => {
  test('accepts a simple valid TSX component using only React and the Pawprint SDK', async () => {
    const src = `
      import React from 'react'
      import { useState } from 'react'
      import { getState, setState } from '${PAWPRINT_SDK_MODULE}'

      export default function App() {
        const [n, setN] = useState(0)
        return <div onClick={() => setN(n + 1)}>{n}</div>
      }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
  })

  test('accepts an explicitly-approved extra package import', async () => {
    const src = `
      import { format } from 'date-fns'
      export default function App() { return <div>{format(new Date(), 'yyyy')}</div> }
    `
    const res = await validatePawprintSource(src, ['date-fns'])
    expect(res.ok).toBe(true)
  })

  test('rejects an import that is not React/SDK/approved', async () => {
    // esbuild's TS transform elides value imports it can prove are never referenced (mirroring
    // tsc's isolatedModules import elision), so the import must actually be used or esbuild
    // strips it before acorn ever sees it — defeating the point of this test.
    const src = `
      import fs from 'fs'
      export default function App() { return <div>{typeof fs}</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('Disallowed import "fs"'))).toBe(true)
  })

  test('rejects an unapproved package that was not passed in approvedPackageNames', async () => {
    const src = `
      import { format } from 'date-fns'
      export default function App() { return <div>{format(new Date(), 'yyyy')}</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('date-fns'))).toBe(true)
  })

  test('rejects dynamic import()', async () => {
    const src = `
      export default function App() {
        import('some-module')
        return <div>hi</div>
      }
    `
    const res = await validatePawprintSource(src, ['some-module'])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('Dynamic import()'))).toBe(true)
  })

  test('rejects require as a disallowed global identifier', async () => {
    const src = `
      export default function App() {
        const x = require('fs')
        return <div>{String(x)}</div>
      }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"require"'))).toBe(true)
  })

  test('rejects process as a disallowed global identifier', async () => {
    const src = `
      export default function App() { return <div>{process.env.SECRET}</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"process"'))).toBe(true)
  })

  test('rejects eval as a disallowed global identifier', async () => {
    const src = `
      export default function App() { eval('1+1'); return <div>hi</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('"eval"'))).toBe(true)
  })

  test('rejects __dirname and __filename', async () => {
    const src = `
      export default function App() { return <div>{__dirname}{__filename}</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('__dirname'))).toBe(true)
    expect(res.errors.some((e) => e.includes('__filename'))).toBe(true)
  })

  test('rejects globalThis', async () => {
    const src = `
      export default function App() { return <div>{String(globalThis)}</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('globalThis'))).toBe(true)
  })

  test('deduplicates repeated identical errors', async () => {
    const src = `
      export default function App() {
        eval('1')
        eval('2')
        return <div>hi</div>
      }
    `
    const res = await validatePawprintSource(src, [])
    const evalErrors = res.errors.filter((e) => e.includes('"eval"'))
    expect(evalErrors.length).toBe(1)
  })

  test('returns a compile error for genuinely malformed TSX rather than throwing', async () => {
    const src = `export default function App( { return <div>`
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
  })

  test('accepts react-dom/client and react/jsx-runtime as always-allowed imports', async () => {
    const src = `
      import { createRoot } from 'react-dom/client'
      export default function App() { return <div>{typeof createRoot}</div> }
    `
    const res = await validatePawprintSource(src, [])
    expect(res.ok).toBe(true)
  })
})
