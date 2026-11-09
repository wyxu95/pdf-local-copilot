import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { LocalHistory, readHistoryFile } from '../src/local-history';

async function fixture() {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-local-history-')), root = path.join(repository, 'paper'); await fs.mkdir(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Local History Test'); git('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(repository, '.gitignore'), '.pdf-local-copilot/\n*.bbl\n*.blg\n*.cache\n');
  await fs.writeFile(path.join(root, 'main.tex'), 'Original paragraph.\n'); await fs.writeFile(path.join(root, 'refs.bib'), 'Original bibliography.\n');
  git('add', '.'); git('commit', '-qm', 'Baseline');
  const history = new LocalHistory(root, 'main.tex'); await history.refresh();
  const read = (point: string, side: 'before' | 'after', file = 'main.tex') => readHistoryFile(root, 'main.tex', history.head!, point, side, file);
  return { repository, root, history, git, read, close: () => fs.rm(repository, { recursive: true, force: true }) };
}
test('local checkpoints reconstruct immutable before/after diffs, survive restart, and preserve the Git index', async () => {
  const f = await fixture();
  try {
    assert.equal(f.history.points.length, 0);
    await fs.writeFile(path.join(f.root, 'main.tex'), 'First edit.\n'); await f.history.approve('接受修改', new Map([['main.tex', Buffer.from('First edit.\n')]]));
    const first = f.history.points[0].id;
    await fs.writeFile(path.join(f.root, 'main.tex'), 'Second edit.\n'); await f.history.approve('接受修改', new Map([['main.tex', Buffer.from('Second edit.\n')]]));
    const second = f.history.points[1].id;
    assert.equal((await f.read(first, 'before')).toString(), 'Original paragraph.\n'); assert.equal((await f.read(first, 'after')).toString(), 'First edit.\n');
    assert.equal((await f.read(second, 'before')).toString(), 'First edit.\n'); assert.equal((await f.read(second, 'after')).toString(), 'Second edit.\n');
    await fs.writeFile(path.join(f.root, 'main.tex'), 'Edited while closed.\n');
    const reopened = new LocalHistory(f.root, 'main.tex'); await reopened.refresh();
    assert.equal(reopened.points.length, 2); assert.equal((await f.read(first, 'after')).toString(), 'First edit.\n');
    assert.equal(f.git('diff', '--cached', '--name-only'), '', 'Recording history changed the staging area');
    const stored = JSON.parse(await fs.readFile(path.join(f.root, '.pdf-local-copilot/history', (await fs.readdir(path.join(f.root, '.pdf-local-copilot/history')))[0], 'index.json'), 'utf8'));
    assert.ok(stored.points.every((point: any) => point.files.every((file: any) => typeof file.patch === 'string' && !('before' in file) && !('after' in file))));
  } finally { await f.close(); }
});
test('each commit clears old history files and closes the previous scope, including a partial commit', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'image.bin'), Buffer.from([0, 255, 7]));
    await fs.writeFile(path.join(f.root, 'main.tex'), 'Committed edit.\n'); await fs.writeFile(path.join(f.root, 'refs.bib'), 'Uncommitted bibliography.\n');
    await f.history.approve('接受修改', new Map([['main.tex', Buffer.from('Committed edit.\n')], ['refs.bib', Buffer.from('Uncommitted bibliography.\n')], ['image.bin', Buffer.from([0, 255, 7])]])); const oldHead = f.history.head!, oldPoint = f.history.points[0].id;
    const historyRoot = path.join(f.root, '.pdf-local-copilot/history'), store = path.join(historyRoot, (await fs.readdir(historyRoot))[0]);
    const blobs = await fs.readdir(path.join(store, 'blobs')); assert.equal(blobs.length, 1);
    f.git('add', 'paper/main.tex', 'paper/image.bin'); f.git('commit', '-qm', 'Commit selected files');
    await assert.rejects(readHistoryFile(f.root, 'main.tex', oldHead, oldPoint, 'after', 'main.tex'), /commit/);
    await f.history.refresh();
    assert.notEqual(f.history.head, oldHead); assert.equal(f.history.points.length, 0);
    await f.history.approve('接受书目修改', new Map([['refs.bib', Buffer.from('Uncommitted bibliography.\n')]]));
    await assert.rejects(fs.access(path.join(store, 'blobs')));
    await assert.rejects(readHistoryFile(f.root, 'main.tex', oldHead, oldPoint, 'after', 'main.tex'), /commit/);
    assert.equal((await f.read(f.history.points[0].id, 'before', 'refs.bib')).toString(), 'Original bibliography.\n');
    f.git('add', 'paper/refs.bib'); f.git('commit', '-qm', 'Commit remaining edit'); await f.history.refresh();
    assert.equal(f.history.points.length, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(store, 'index.json'), 'utf8')).points.length, 0);
  } finally { await f.close(); }
});
test('first use includes existing uncommitted changes and records additions, deletions and binary bytes', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'main.tex'), 'Existing local edit.\n'); await fs.unlink(path.join(f.root, 'refs.bib'));
    await fs.writeFile(path.join(f.root, 'new.md'), 'A new note.\n'); await fs.writeFile(path.join(f.root, 'binary.bin'), Buffer.from([0, 254, 3]));
    await fs.writeFile(path.join(f.root, 'paper.bbl'), 'Generated bibliography'); await fs.writeFile(path.join(f.root, 'ignored.cache'), 'Ignored');
    const firstUse = new LocalHistory(f.root, 'main.tex'); await firstUse.refresh(); assert.equal(firstUse.points.length, 0);
    await firstUse.approve('接受变更', new Map([['main.tex', Buffer.from('Existing local edit.\n')], ['refs.bib', undefined], ['new.md', Buffer.from('A new note.\n')], ['binary.bin', Buffer.from([0, 254, 3])]])); const point = firstUse.points[0];
    assert.equal(point.label, '接受变更'); assert.deepEqual(point.files.map(file => file.file).sort(), ['binary.bin', 'main.tex', 'new.md', 'refs.bib']);
    assert.equal((await f.read(point.id, 'before', 'new.md')).length, 0); assert.equal((await f.read(point.id, 'after', 'new.md')).toString(), 'A new note.\n');
    assert.equal((await f.read(point.id, 'before', 'refs.bib')).toString(), 'Original bibliography.\n'); assert.equal((await f.read(point.id, 'after', 'refs.bib')).length, 0);
    assert.deepEqual(await f.read(point.id, 'after', 'binary.bin'), Buffer.from([0, 254, 3]));
  } finally { await f.close(); }
});
test('saving and refreshing create no checkpoints, and partial approvals exclude pending edits', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'main.tex'), 'Accepted first.\nPending second.\n');
    await f.history.refresh(); assert.equal(f.history.points.length, 0);
    const first = Buffer.from('Accepted first.\nOriginal paragraph.\n');
    await f.history.approve('接受所选修改', new Map([['main.tex', first]]));
    assert.equal((await f.read(f.history.points[0].id, 'after')).toString(), first.toString());
    await f.history.refresh(); assert.equal(f.history.points.length, 1);
    await f.history.approve('重复同意', new Map([['main.tex', first]])); assert.equal(f.history.points.length, 1);
    await f.history.approve('接受其余修改', new Map([['main.tex', await fs.readFile(path.join(f.root, 'main.tex'))]]));
    assert.equal(f.history.points.length, 2); assert.equal((await f.read(f.history.points[1].id, 'before')).toString(), first.toString());
  } finally { await f.close(); }
});
test('old automatic save points are archived while the approval list starts empty', async () => {
  const f = await fixture();
  try {
    await f.history.approve('保存修改', new Map([['main.tex', Buffer.from('Old automatic save.\n')]]));
    const base = path.join(f.root, '.pdf-local-copilot/history'), store = path.join(base, (await fs.readdir(base))[0]), file = path.join(store, 'index.json');
    const old = JSON.parse(await fs.readFile(file, 'utf8')); old.version = 1; await fs.writeFile(file, JSON.stringify(old));
    const reopened = new LocalHistory(f.root, 'main.tex'); await reopened.refresh();
    assert.equal(reopened.points.length, 0); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
    assert.equal(JSON.parse(await fs.readFile(path.join(store, 'automatic-v1.json'), 'utf8')).points.length, 1);
    await reopened.approve('接受修改', new Map([['main.tex', Buffer.from('Approved text.\n')]]));
    assert.equal((await f.read(reopened.points[0].id, 'before')).toString(), 'Original paragraph.\n');
    f.git('commit', '--allow-empty', '-qm', 'New commit'); await reopened.refresh();
    await assert.rejects(fs.access(path.join(store, 'automatic-v1.json')));
  } finally { await f.close(); }
});
