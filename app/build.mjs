// Bundles the Electron main process (with the importer engine from plugins/chatgpt-importer) into dist/main.cjs.
// playwright-core stays external (it ships its own files); the engine's `playwright` import is aliased to it,
// so no browser is bundled — the app drives the Edge/Chrome already installed on the PC.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'playwright-core'],
  alias: { playwright: 'playwright-core' },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
copyFileSync('src/preload.cjs', 'dist/preload.cjs');
