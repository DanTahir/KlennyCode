import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Separate, much narrower preload for a Pawprint's own sandboxed BrowserWindow (see
          // pawprints/windowManager.ts, which loads it via
          // join(__dirname, 'preloadPawprint.cjs') — the output file name must match that
          // reference). Deliberately never shares an entry point with the main app's own
          // preload/index.ts.
          preloadPawprint: resolve(__dirname, 'src/preload/preloadPawprint.ts')
        },
        output: {
          // Force plain CommonJS output for BOTH preload entries, with a `.cjs` extension.
          // This is load-bearing, not a style choice — per Electron's own docs
          // (electronjs.org/docs/latest/tutorial/esm#preload-scripts): "Sandboxed preload
          // scripts can't use ESM imports... run as plain JavaScript without an ESM
          // context... Loading the electron API is still done via require('electron')".
          // preloadPawprint.ts loads into a `sandbox: true` BrowserWindow (a hard security
          // requirement, see pawprints plan), so it structurally cannot be ESM, regardless
          // of this package's own "type": "module". electron-vite's preload config also
          // explicitly rejects multiple outputs (one config error for the whole preload
          // build), so both entries must share one format — 'cjs' works for both entries
          // (the main app's non-sandboxed preload/index.ts doesn't require ESM either, it
          // just happened to default to it). Do NOT split format per-entry or reintroduce
          // 'es' here without re-reading this comment.
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': resolve('shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react()],
    base: './',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
