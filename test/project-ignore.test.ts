import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scan, WorkingTree, changes, createTask } from '../src/project';

test('workspace diffs follow Git ignores and omit generated bibliography files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-ignore-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root }); await fs.writeFile(path.join(root, '.gitignore'), '*.cache\nignored/\n*.bbl\n*.blg\n');
    await fs.writeFile(path.join(root, 'main.tex'), 'Original'); await fs.writeFile(path.join(root, 'tracked.cache'), 'Tracked source');
    execFileSync('git', ['add', '-f', 'tracked.cache'], { cwd: root });
    await fs.mkdir(path.join(root, 'ignored')); await fs.writeFile(path.join(root, 'ignored/large.bin'), Buffer.alloc(100000));
    await fs.writeFile(path.join(root, 'scratch.cache'), 'Ignored'); await fs.writeFile(path.join(root, 'paper.bbl'), 'Generated'); await fs.writeFile(path.join(root, 'paper.blg'), 'Generated log');
    const files = await scan(root, 'main.tex'); assert.ok(files.has('tracked.cache')); assert.ok(!files.has('scratch.cache')); assert.ok(!files.has('paper.bbl')); assert.ok(!files.has('paper.blg')); assert.ok(!files.has('ignored/large.bin'));
    const tracker = await WorkingTree.create(root, path.join(root, 'main.tex'));
    await fs.writeFile(path.join(root, 'paper.bbl'), 'New generated content'); await fs.writeFile(path.join(root, 'scratch.cache'), 'New ignored content'); await fs.writeFile(path.join(root, 'main.tex'), 'Revised'); await tracker.capture();
    assert.deepEqual((await changes(tracker.task)).map(change => change.file), ['main.tex']);
    assert.deepEqual(await fs.readdir(tracker.task.baseline), ['main.tex']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('legacy task snapshots retain their changes when stored in a Git-ignored directory', async () => {
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-ignored-snapshot-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repository });
    await fs.writeFile(path.join(repository, '.gitignore'), 'ignored/\n');
    const root = path.join(repository, 'paper'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'main.tex'), 'Original');
    const task = await createTask(root, path.join(root, 'main.tex'), path.join(repository, 'ignored'));
    await fs.writeFile(path.join(task.proposal, 'main.tex'), 'Revised');
    await fs.writeFile(path.join(task.proposal, 'appendix.tex'), 'New appendix');
    assert.deepEqual((await changes(task)).map(change => change.file), ['appendix.tex', 'main.tex']);
  } finally { await fs.rm(repository, { recursive: true, force: true }); }
});
