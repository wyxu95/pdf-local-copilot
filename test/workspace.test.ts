import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkingTree, changes } from '../src/project';
import { makeReview, decide, saveReview, loadReview } from '../src/review';
import { recordWorkspace, undoApplication } from '../src/history';

test('live workspace stores only changed originals and supports restart, hunk rejection and guarded undo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-workspace-'));
  const original = 'First old statement.\n\n' + 'Unchanged explanation. '.repeat(5) + '\n\nSecond old statement.\n';
  await fs.writeFile(path.join(root, 'main.tex'), original); await fs.writeFile(path.join(root, 'refs.bib'), 'Old bibliography'); await fs.writeFile(path.join(root, 'unchanged.dat'), 'untouched data'.repeat(10000));
  try {
    const tree = await WorkingTree.create(root, path.join(root, 'main.tex'), { claude: 'existing-session' }), task = tree.task;
    assert.equal(task.proposal, root); assert.ok(task.dir.startsWith(path.join(root, '.pdf-local-copilot'))); assert.deepEqual(await fs.readdir(task.baseline), []);
    await fs.writeFile(path.join(root, 'main.tex'), original.replaceAll('old', 'precise')); await fs.unlink(path.join(root, 'refs.bib')); await fs.writeFile(path.join(root, 'appendix.tex'), 'New appendix'); await tree.capture();
    assert.deepEqual((await changes(task)).map(change => [change.file, change.kind]), [['appendix.tex', 'added'], ['main.tex', 'modified'], ['refs.bib', 'deleted']]);
    assert.deepEqual((await fs.readdir(task.baseline)).sort(), ['main.tex', 'refs.bib']);
    const review = makeReview(await changes(task)); await saveReview(task, review);
    const saved = JSON.parse(await fs.readFile(path.join(task.dir, 'review.json'), 'utf8')); assert.equal(saved.version, 2); assert.ok(!('before' in saved.files[0])); assert.ok(!('proposed' in saved.files[0]));
    const main = review.files.find(file => file.file === 'main.tex')!; await decide(task, review, main.edits[1].id, 'rejected');
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), original.replace('old', 'precise'));
    const restored = await WorkingTree.open(JSON.parse(await fs.readFile(path.join(task.dir, 'task.json'), 'utf8'))), reloaded = (await loadReview(task))!;
    assert.equal(restored.task.sessions?.claude, 'existing-session');
    await decide(task, reloaded, main.edits[1].id, 'accepted'); assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), original.replaceAll('old', 'precise'));
    const record = await recordWorkspace(task, await changes(task));
    await fs.writeFile(path.join(root, 'main.tex'), 'Later author edit'); await assert.rejects(undoApplication(record, root), /Source changed/);
    assert.equal(await fs.readFile(path.join(root, 'appendix.tex'), 'utf8'), 'New appendix');
    await fs.writeFile(path.join(root, 'main.tex'), original.replaceAll('old', 'precise')); await undoApplication(record, root);
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), original); assert.equal(await fs.readFile(path.join(root, 'refs.bib'), 'utf8'), 'Old bibliography'); await assert.rejects(fs.access(path.join(root, 'appendix.tex')));
    await fs.access(path.join(root, 'unchanged.dat'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('binary changes retain exact bytes through persisted review and rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-workspace-binary-'));
  try {
    await fs.writeFile(path.join(root, 'main.tex'), 'Test'); const old = Buffer.from([0, 255, 3]), next = Buffer.from([0, 128, 5]); await fs.writeFile(path.join(root, 'image.png'), old);
    const tree = await WorkingTree.create(root, path.join(root, 'main.tex')); await fs.writeFile(path.join(root, 'image.png'), next); await tree.capture();
    const review = makeReview(await changes(tree.task)); await saveReview(tree.task, review); const loaded = (await loadReview(tree.task))!;
    await decide(tree.task, loaded, loaded.files[0].edits[0].id, 'rejected'); assert.deepEqual(await fs.readFile(path.join(root, 'image.png')), old);
    await decide(tree.task, loaded, loaded.files[0].edits[0].id, 'accepted'); assert.deepEqual(await fs.readFile(path.join(root, 'image.png')), next);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('files edited while the extension is closed remain the live baseline when no old change was recorded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-workspace-external-'));
  try {
    await fs.writeFile(path.join(root, 'main.tex'), 'Original'); const tree = await WorkingTree.create(root, path.join(root, 'main.tex'));
    await fs.writeFile(path.join(root, 'main.tex'), 'Edited outside the extension');
    const resumed = await WorkingTree.open(tree.task); await resumed.capture(); assert.deepEqual(await changes(resumed.task), []);
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), 'Edited outside the extension');
    assert.deepEqual(resumed.task.externalChanges, ['main.tex']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
