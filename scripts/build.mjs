import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', target: 'node20', external: ['vscode'], sourcemap: true });
await build({ entryPoints: ['webview/app.js'], outfile: 'dist/app.js', bundle: true, platform: 'browser', target: 'chrome120' });
await copyFile('webview/style.css', 'dist/style.css');
await copyFile('node_modules/diff/LICENSE', 'dist/JSdiff-LICENSE');
