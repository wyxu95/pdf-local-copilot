import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BuildManager } from '../src/build';
import { LivePreview } from '../src/live';

test('workspace-host rendering handles Unicode paths, spaces and Windows line endings', { timeout: 60000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-remote-')), root = path.join(await fs.realpath(temporary), 'paper with spaces 论文'), main = path.join(root, 'main.tex');
  await fs.mkdir(root);
  await fs.writeFile(main, '\\documentclass{article}\r\n\\begin{document}\r\nRemote workspace text.\r\n\\end{document}\r\n');
  const build = new BuildManager(root, main, 'xelatex', () => {}); let preview: LivePreview | undefined;
  try {
    await build.build();
    preview = new LivePreview(path.resolve('native/texpresso'), root, main, { frame: () => {}, state: () => {}, log: () => {}, error: error => { throw error; } }, { includeDirectories: [build.directory] });
    await preview.start(); const deadline = Date.now() + 20000;
    while (!preview.snapshot().complete) { assert.ok(Date.now() < deadline, 'Rendering timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
    const frame = await preview.readPage(0);
    assert.ok(frame.header.characters!.map(char => String.fromCodePoint(char[0])).join('').includes('Remote workspace text.'));
    const position = await preview.position(main, 3); assert.equal(position.page, 0);
    const source = await preview.locate(frame.header, position.x, position.y); assert.equal(source.file, main);
  } finally { await preview?.stop(); await build.stop(); await fs.rm(temporary, { recursive: true, force: true }); }
});
