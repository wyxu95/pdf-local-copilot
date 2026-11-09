import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { makeReview, materialize, reviewPlan, decide, mapLine } from '../src/review';
import { createTask, changes } from '../src/project';
import { applyWithUndo, undoApplication } from '../src/history';
test('two distant edits on the same source line can be decided independently', () => {
  const before = 'The first old claim. ' + 'Unchanged explanation with plenty of separating context. '.repeat(2) + 'The second old claim.\r\n';
  const after = before.replace('first old', 'first precise').replace('second old', 'second supported');
  const review = makeReview([{ file: 'main.tex', kind: 'modified', before: Buffer.from(before), after: Buffer.from(after) }]);
  assert.equal(review.files[0].edits.length, 2);
  review.files[0].edits[0].decision = 'accepted'; review.files[0].edits[1].decision = 'rejected';
  const result = reviewPlan(review, true)[0].after!.toString();
  assert.equal(result, before.replace('first old', 'first precise')); assert.ok(result.endsWith('\r\n'));
  assert.equal(materialize(review.files[0], e => e.decision !== 'rejected')!.toString(), result);
});
test('rejecting one edit preserves other proposal edits; applying and undoing preserves concurrent author edits', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-review-')), root = path.join(temp, 'paper'); await fs.mkdir(root);
  const original = 'First old statement.\n\n' + 'Unchanged context. '.repeat(5) + '\n\nSecond old statement.\n';
  await fs.writeFile(path.join(root, 'main.tex'), original);
  const task = await createTask(root, path.join(root, 'main.tex'), path.join(temp, 'storage'));
  try {
    await fs.writeFile(path.join(task.proposal, 'main.tex'), original.replaceAll('old', 'precise'));
    const review = makeReview(await changes(task)); assert.equal(review.files[0].edits.length, 2);
    await decide(task, review, review.files[0].edits[0].id, 'accepted');
    await decide(task, review, review.files[0].edits[1].id, 'rejected');
    assert.equal(await fs.readFile(path.join(task.proposal, 'main.tex'), 'utf8'), original.replace('old', 'precise'));
    const journal = await applyWithUndo(root, reviewPlan(review, true), path.join(temp, 'storage'));
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), original.replace('old', 'precise'));
    await fs.writeFile(path.join(root, 'main.tex'), 'Concurrent author edit');
    await assert.rejects(undoApplication(journal, root), /Source changed/);
    await fs.writeFile(path.join(root, 'main.tex'), original.replace('old', 'precise'));
    await undoApplication(journal, root); assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), original);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
test('source anchors follow inserted and removed lines', () => {
  assert.deepEqual(mapLine('one\ntwo\nthree\n', 'preface\none\ntwo\nthree\n', 2), { line: 3, changed: false });
  assert.deepEqual(mapLine('one\ntwo\nthree\n', 'one\nthree\n', 2), { line: 2, changed: true });
});
test('an agent reintroducing a previously rejected edit creates a fresh pending decision', () => {
  const change = { file: 'main.tex', kind: 'modified' as const, before: Buffer.from('old statement'), after: Buffer.from('new statement') };
  const previous = makeReview([change]); previous.files[0].edits[0].decision = 'rejected';
  const next = makeReview([change], previous); assert.equal(next.files[0].edits[0].decision, 'pending');
  assert.equal(materialize(next.files[0], e => e.decision !== 'rejected')!.toString(), 'new statement');
});
