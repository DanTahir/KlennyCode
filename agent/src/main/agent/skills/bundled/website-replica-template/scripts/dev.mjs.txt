#!/usr/bin/env node
/**
 * Starts Next on the port declared in replica.config.json, so the port lives
 * in exactly one place (the verification scripts read the same field).
 *
 *   node scripts/dev.mjs            dev server
 *   node scripts/dev.mjs --start    production server (after `npm run build`)
 */
import { spawn } from 'node:child_process';
import { loadConfig } from './lib/config.mjs';

const cfg = await loadConfig();
const mode = process.argv.includes('--start') ? 'start' : 'dev';
const port = String(cfg.port);

console.log(`next ${mode} on http://localhost:${port}  (replica of ${cfg.targetUrl})`);

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['next', mode, '--port', port],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

child.on('exit', (code) => process.exit(code ?? 0));
