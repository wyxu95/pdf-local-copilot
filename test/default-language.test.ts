import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { displayHistoryLabel } from '../src/history-label';
import { prompt } from '../src/agent';
import type { Task } from '../src/project';

test('default interface text is English across the manifest, backend and webview', async () => {
  const files = ['package.json', ...await fs.readdir('src').then(names => names.filter(name => name.endsWith('.ts') && name !== 'history-label.ts').map(name => path.join('src', name))), 'webview/app.js'];
  for (const file of files) assert.ok(!/\p{Script=Han}/u.test(await fs.readFile(file, 'utf8')), `Untranslated default UI text in ${file}`);
  const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.deepEqual(manifest.contributes.views.pdfLocal.map((view: { name: string }) => view.name), ['PDF Annotations', 'Current Changes', 'Local History']);
  assert.ok((await fs.readFile('src/paper.ts', 'utf8')).includes('<html lang="en"'));
});
test('legacy generated history labels display in English while author text is preserved', () => {
  assert.equal(displayHistoryLabel('接受所选修改 · 3 处'), 'Accepted Changes · 3');
  assert.equal(displayHistoryLabel('接受修改 · 论文.tex'), 'Accepted Change · 论文.tex');
  assert.equal(displayHistoryLabel('用户自己的记录'), '用户自己的记录');
  const task: Task = { id: 'test', mode: 'workspace', root: '/paper', proposal: '/paper', dir: '/paper/history', baseline: '/paper/before', main: 'paper.tex' };
  const content = prompt(task, [{ id: 'note', page: 0, rects: [], quote: '原始正文', comment: '保持术语不变' }], '只修改这一段');
  for (const text of ['原始正文', '保持术语不变', '只修改这一段']) assert.ok(content.includes(text));
});
