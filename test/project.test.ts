import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, changes, applyChanges, scan } from '../src/project';

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-copilot-test-'));
  const root = path.join(temp, 'paper'), storage = path.join(temp, 'storage'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.tex'), 'Original manuscript\n');
  await fs.writeFile(path.join(root, 'refs.bib'), 'Original reference\n');
  return { temp, root, task: await createTask(root, path.join(root, 'main.tex'), storage) };
}
test('task copy preserves manuscript; detects edits, additions, deletions; applies selected files', async () => {
  const { temp, root, task } = await fixture();
  try {
    await fs.writeFile(path.join(task.proposal, 'main.tex'), 'Revised manuscript\n');
    await fs.unlink(path.join(task.proposal, 'refs.bib'));
    await fs.writeFile(path.join(task.proposal, 'appendix.tex'), 'New appendix\n');
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'Original manuscript\n');
    assert.deepEqual((await changes(task)).map(c => [c.file, c.kind]), [['appendix.tex', 'added'], ['main.tex', 'modified'], ['refs.bib', 'deleted']]);
    await applyChanges(task, ['main.tex', 'appendix.tex']);
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'Revised manuscript\n');
    assert.equal(await fs.readFile(path.join(root, 'refs.bib'), 'utf8'), 'Original reference\n');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
test('conflict check blocks the complete batch before writing', async () => {
  const { temp, root, task } = await fixture();
  try {
    await fs.writeFile(path.join(task.proposal, 'main.tex'), 'AI edit');
    await fs.writeFile(path.join(task.proposal, 'refs.bib'), 'AI reference');
    await fs.writeFile(path.join(root, 'refs.bib'), 'Concurrent author edit');
    await assert.rejects(applyChanges(task, ['main.tex', 'refs.bib']), /Source changed/);
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'Original manuscript\n');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
test('symlinks are rejected in copies and in destination parent directories', async () => {
  const { temp, root, task } = await fixture();
  try {
    await fs.mkdir(path.join(task.proposal, 'section'));
    await fs.writeFile(path.join(task.proposal, 'section', 'new.tex'), 'AI edit');
    await fs.symlink(temp, path.join(root, 'section'));
    await assert.rejects(applyChanges(task, ['section/new.tex']), /Symbolic link/);
    await assert.rejects(scan(root, 'main.tex'), /symbolic link/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
