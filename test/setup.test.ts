import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { inspectTools } from '../src/setup';
import { localEnvironment } from '../src/process';

test('setup inspection reports available and missing tools without stopping the other checks', async () => {
  const tools = await inspectTools([
    { name: 'Node', command: process.execPath, args: ['--version'] },
    { name: 'Missing', command: path.join(homedir(), 'copilot-nonexistent-tool-94dba1'), args: ['--version'] }
  ]);
  assert.ok(tools[0].ok && /^v\d+/.test(tools[0].detail));
  assert.ok(!tools[1].ok && tools[1].detail.includes('ENOENT'));
});
test('workspace tools use the backend home directory and remote menus remain available', async () => {
  const paths = localEnvironment().PATH.split(path.delimiter), local = path.join(homedir(), '.local/bin');
  assert.ok(paths.includes(local));
  if (process.platform === 'linux') assert.equal(paths[0], local, 'WSL must prefer Linux user tools over Windows PATH entries');
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.ok(manifest.contributes.commands.find((command: { command: string }) => command.command === 'pdfLocal.pdfPosition').enablement.includes('vscode-remote'));
  assert.ok(manifest.contributes.menus['editor/context'].find((item: { command: string }) => item.command === 'pdfLocal.pdfPosition').when.includes('vscode-remote'));
});
