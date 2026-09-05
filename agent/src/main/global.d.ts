// Ambient module declarations for main-process-only Vite asset imports (mirrors
// src/renderer/global.d.ts's *.jpg declaration). tsconfig.node.json doesn't pull in the
// `vite/client` lib (that's renderer-only), so `*.md?raw` needs its own declaration here for
// bundledSkills.ts's `import x from './foo.md?raw'` to type-check.
declare module '*.md?raw' {
  const content: string
  export default content
}

// `*.txt?raw` is for websiteReplicaTemplate.ts, which vendors the website-replica skill's project
// template with a `.txt` suffix appended to every file. That suffix is deliberate: the template
// contains real .ts/.tsx/.mjs sources for a *different* project, and under their true extensions
// inside src/main/ they'd be type-checked by tsconfig.node.json (whose `include` covers
// src/main/**/*) and collected by `bun test` (which auto-discovers *.test.ts). See
// websiteReplicaTemplate.ts's file-level comment.
declare module '*.txt?raw' {
  const content: string
  export default content
}
