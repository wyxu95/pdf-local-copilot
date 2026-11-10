import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { acceptCommittedReview, committedReviewFiles, gitHead } from '../src/commit-review';
import { makeReview, materialize, associateReview, resolvedNoteIds, saveReview, loadReview, decide, editPosition } from '../src/review';
import { WorkingTree } from '../src/project';

const bytes = (value: string) => Buffer.from(value);
const change = (file: string, before: string | undefined, after: string | undefined) => ({ file, kind: before === undefined ? 'added' as const : after === undefined ? 'deleted' as const : 'modified' as const, before: before === undefined ? undefined : bytes(before), after: after === undefined ? undefined : bytes(after) });
test('a partial commit accepts only included edits and preserves request provenance after refresh', () => {
  const before = 'Alpha old then Beta old.\n', after = 'Alpha new then Beta new.\n', committed = 'Alpha new then Beta old.\n';
  const changes = [change('main.tex', before, after), change('plan.md', 'Old plan', 'New plan')];
  const review = makeReview(changes); assert.equal(review.files[0].edits.length, 1);
  Object.assign(review.files[0].edits[0], { origin: 'annotation', requestId: 'request', noteIds: ['note'] });
  const original = structuredClone(review), first = acceptCommittedReview(review, new Map([['main.tex', bytes(committed)]]));
  assert.deepEqual(review, original, 'Commit analysis mutated the live review');
  assert.ok(first.accepted > 0 && first.review.files[0].edits.some(edit => edit.decision === 'pending'));
  assert.equal(materialize(first.review.files[0], edit => edit.decision === 'accepted')!.toString(), committed);
  assert.equal(materialize(first.review.files[0], edit => edit.decision !== 'rejected')!.toString(), after);
  assert.ok(first.review.files[0].edits.every(edit => edit.requestId === 'request' && edit.noteIds?.[0] === 'note'));
  assert.ok(first.review.files[1].edits.every(edit => edit.decision === 'pending'));
  assert.ok(!resolvedNoteIds(first.review).has('note'));
  const refreshed = makeReview(changes, first.review); associateReview(refreshed, first.review);
  const repeated = acceptCommittedReview(refreshed, new Map([['main.tex', bytes(committed)]]));
  assert.equal(materialize(repeated.review.files[0], edit => edit.decision === 'accepted')!.toString(), committed);
  assert.ok(repeated.review.files[0].edits.every(edit => edit.origin === 'annotation' && edit.noteIds?.[0] === 'note'));
  const completed = acceptCommittedReview(repeated.review, new Map([['main.tex', bytes(after)]]));
  assert.ok(completed.review.files[0].edits.every(edit => edit.decision === 'accepted'));
  assert.ok(resolvedNoteIds(completed.review).has('note'));
});
test('partial new files and deletions retain exact materialization and rejection behavior', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-commit-files-')), root = await fs.realpath(temporary);
  await fs.writeFile(path.join(root, 'main.tex'), 'Paper'); await fs.writeFile(path.join(root, 'deleted.txt'), 'First line\nSecond line\n');
  const tree = await WorkingTree.create(root, path.join(root, 'main.tex'));
  try {
    const added = 'First line\nSecond line\n', committedAdded = 'First line\n';
    await fs.writeFile(path.join(root, 'added.txt'), added); await fs.unlink(path.join(root, 'deleted.txt')); await tree.capture();
    const review = makeReview([change('added.txt', undefined, added), change('deleted.txt', added, undefined)]);
    const result = acceptCommittedReview(review, new Map([['added.txt', bytes(committedAdded)], ['deleted.txt', bytes('Second line\n')]]));
    assert.equal(materialize(result.review.files[0], edit => edit.decision === 'accepted')!.toString(), committedAdded);
    assert.equal(materialize(result.review.files[0], edit => edit.decision !== 'rejected')!.toString(), added);
    const pendingAdded = result.review.files[0].edits.find(edit => edit.decision === 'pending')!;
    assert.equal(editPosition(result.review.files[0], pendingAdded).offset, committedAdded.length);
    assert.equal(materialize(result.review.files[1], edit => edit.decision === 'accepted')!.toString(), 'Second line\n');
    assert.equal(materialize(result.review.files[1], edit => edit.decision !== 'rejected'), undefined);
    await saveReview(tree.task, result.review);
    const loaded = (await loadReview(tree.task))!;
    assert.equal(materialize(loaded.files[0], () => true)!.toString(), added);
    for (const file of loaded.files) for (const edit of file.edits.filter(edit => edit.decision === 'pending')) await decide(tree.task, loaded, edit.id, 'rejected');
    assert.equal(await fs.readFile(path.join(root, 'added.txt'), 'utf8'), committedAdded);
    assert.equal(await fs.readFile(path.join(root, 'deleted.txt'), 'utf8'), 'Second line\n');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('Git commit detection handles nested Unicode projects, multiple commits and untouched files', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-committed-')), repository = await fs.realpath(temporary), root = path.join(repository, 'paper 论文');
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input });
  await fs.mkdir(root); git(['init', '-q', repository]); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  const before = 'First old.\n\nUnchanged context separates edits.\n\nSecond old.\n', after = before.replaceAll('old', 'new'), partial = before.replace('old', 'new');
  await fs.writeFile(path.join(root, 'main.tex'), before); await fs.writeFile(path.join(root, 'plan.md'), 'Old plan'); git(['add', '.']); git(['commit', '-qm', 'Baseline']);
  try {
    const start = (await gitHead(root))!;
    await fs.writeFile(path.join(root, 'main.tex'), after); await fs.writeFile(path.join(root, 'plan.md'), 'New plan');
    const review = makeReview([change('main.tex', before, after), change('plan.md', 'Old plan', 'New plan')]);
    const blob = git(['hash-object', '-w', '--stdin'], partial).trim(); git(['update-index', '--cacheinfo', `100644,${blob},paper 论文/main.tex`]); git(['commit', '-qm', 'Partial']);
    const head = (await gitHead(root))!, files = await committedReviewFiles(root, start, head, review.files.map(file => file.file));
    assert.equal(files.get('main.tex')!.toString(), partial); assert.ok(!files.has('plan.md'));
    const first = acceptCommittedReview(review, files);
    assert.equal(first.review.files[0].edits.filter(edit => edit.decision === 'accepted').length, 1);
    assert.equal(first.review.files[0].edits.filter(edit => edit.decision === 'pending').length, 1);
    assert.equal(await fs.readFile(path.join(root, 'main.tex'), 'utf8'), after, 'Accepting a commit changed the working file');
    git(['add', 'main.tex']); git(['commit', '-qm', 'Remaining TeX']);
    const second = acceptCommittedReview(first.review, await committedReviewFiles(root, start, (await gitHead(root))!, review.files.map(file => file.file)));
    assert.ok(second.review.files[0].edits.every(edit => edit.decision === 'accepted'));
    assert.ok(second.review.files[1].edits.every(edit => edit.decision === 'pending'));
    await fs.writeFile(path.join(root, 'main.tex'), before); git(['add', 'main.tex']); git(['commit', '-qm', 'Return to original committed contents']);
    const returned = await committedReviewFiles(root, start, (await gitHead(root))!, ['main.tex']);
    assert.ok(returned.has('main.tex'), 'A commit returning to the round-start content was ignored');
    assert.equal(acceptCommittedReview(makeReview([change('main.tex', 'Uncommitted author draft', before)]), returned).accepted, 1);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('binary commits are accepted only when their bytes match the working proposal', () => {
  const review = makeReview([{ file: 'image.dat', kind: 'modified', before: Buffer.from([0, 1]), after: Buffer.from([0, 2]) }]);
  assert.equal(acceptCommittedReview(review, new Map([['image.dat', Buffer.from([0, 3])]])).accepted, 0);
  assert.equal(acceptCommittedReview(review, new Map([['image.dat', Buffer.from([0, 2])]])).accepted, 1);
});
test('Git line-ending normalization confirms CRLF changes without altering their bytes', () => {
  const before = 'First old.\r\n\r\nSecond old.\r\n', after = before.replaceAll('old', 'new'), partial = before.replace('old', 'new').replaceAll('\r\n', '\n');
  const review = makeReview([change('main.tex', before, after)]), result = acceptCommittedReview(review, new Map([['main.tex', bytes(partial)]]));
  assert.ok(result.accepted > 0 && result.review.files[0].edits.some(edit => edit.decision === 'pending'));
  assert.equal(materialize(result.review.files[0], edit => edit.decision !== 'rejected')!.toString(), after);
  const complete = acceptCommittedReview(result.review, new Map([['main.tex', bytes(after.replaceAll('\r\n', '\n'))]]));
  assert.ok(complete.review.files[0].edits.every(edit => edit.decision === 'accepted'));
});
test('committing an empty file retains an uncommitted file deletion', () => {
  const review = makeReview([change('empty.txt', 'Previous contents', undefined)]), result = acceptCommittedReview(review, new Map([['empty.txt', Buffer.alloc(0)]]));
  assert.ok(result.review.files[0].edits.some(edit => edit.decision === 'pending'));
  assert.deepEqual(materialize(result.review.files[0], edit => edit.decision === 'accepted'), Buffer.alloc(0));
  assert.equal(materialize(result.review.files[0], edit => edit.decision !== 'rejected'), undefined);
  const complete = acceptCommittedReview(result.review, new Map([['empty.txt', undefined]]));
  assert.ok(complete.review.files[0].edits.every(edit => edit.decision === 'accepted'));
});
