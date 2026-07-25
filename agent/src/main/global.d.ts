// Ambient module declarations for main-process-only Vite asset imports (mirrors
// src/renderer/global.d.ts's *.jpg declaration). tsconfig.node.json doesn't pull in the
// `vite/client` lib (that's renderer-only), so `*.md?raw` needs its own declaration here for
// bundledSkills.ts's `import x from './foo.md?raw'` to type-check.
declare module '*.md?raw' {
  const content: string
  export default content
}
