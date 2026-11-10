import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { localEnvironment } from '../src/process';

test('simultaneous cold starts publish one complete shared TeX format', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-cold-format-'));
  try {
    const logs = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const directory = path.join(root, String(index)), main = path.join(directory, 'main.tex');
      await fs.mkdir(directory);
      await fs.writeFile(main, '\\documentclass{article}\n\\begin{document}\nA startup passage.\n\\end{document}\n');
      return new Promise<string>((resolve, reject) => execFile(path.resolve('native/texpresso-xetex'), ['-texlive', main], {
        cwd: directory, env: { ...localEnvironment(), XDG_CACHE_HOME: path.join(root, 'cache') }, timeout: 30000, maxBuffer: 2 * 1024 * 1024
      }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout + stderr)));
    }));
    for (const log of logs) assert.match(log, /Document generation: Spotless execution/);
    assert.equal(logs.reduce((count, log) => count + (log.match(/Format generation:/g) || []).length, 0), 1);
    const files = await fs.readdir(path.join(root, 'cache/texpresso/format'));
    assert.ok(files.some(file => file.endsWith('.fmt')) && files.some(file => file.endsWith('.deps')));
    assert.ok(files.every(file => !file.includes('.tmp-')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
