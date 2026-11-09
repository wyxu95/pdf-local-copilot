import { test } from 'node:test';
import assert from 'node:assert/strict';
import { associateReview, resolvedNoteIds, type Review, type ReviewRequest, type Edit } from '../src/review';

const edit = (id: string, line: number): Edit => ({ id, file: 'main.tex', start: 0, end: 3, inserted: 'new', removed: 'old', beforeLine: line, afterLine: line, decision: 'pending' });
test('review edits link to source annotations and resolve only after all linked changes are accepted', () => {
  const review: Review = { version: 1, files: [{ file: 'main.tex', binary: false, edits: [edit('a', 10), edit('b', 11), edit('c', 30)] }] };
  const request: ReviewRequest = { id: 'turn', instruction: 'Revise', notes: [{ id: 'n1', number: 1, page: 0, quote: 'old', comment: 'Improve this', rects: [] }, { id: 'n2', number: 2, page: 1, quote: 'old', comment: 'Keep this precise', rects: [] }], anchors: [{ noteId: 'n1', file: 'main.tex', line: 10, endLine: 11 }, { noteId: 'n2', file: 'main.tex', line: 30, endLine: 30 }] };
  associateReview(review, undefined, request); const edits = review.files[0].edits;
  assert.deepEqual(edits[0].noteIds, ['n1']); assert.deepEqual(edits[2].noteIds, ['n2']);
  edits[0].decision = 'accepted'; assert.ok(!resolvedNoteIds(review).has('n1')); edits[1].decision = 'accepted'; assert.ok(resolvedNoteIds(review).has('n1')); assert.ok(!resolvedNoteIds(review).has('n2'));
});
test('direct session requests are labeled separately and existing annotation origins survive later turns', () => {
  const original: Review = { version: 1, files: [{ file: 'main.tex', binary: false, edits: [{ ...edit('a', 10), origin: 'annotation', noteIds: ['n1'], requestId: 'original' }] }] };
  const next: Review = { version: 1, files: [{ file: 'main.tex', binary: false, edits: [edit('a', 10), edit('b', 40)] }] };
  associateReview(next, original, { id: 'direct', instruction: 'Change the heading', notes: [], anchors: [] });
  assert.equal(next.files[0].edits[0].origin, 'annotation'); assert.equal(next.files[0].edits[1].origin, 'session'); assert.equal(next.requests?.[0].instruction, 'Change the heading');
});
test('adjacent source annotations retain independent accept and cleanup decisions', () => {
  const review: Review = { version: 1, files: [{ file: 'main.tex', binary: false, edits: [edit('a', 10), edit('b', 12)] }] };
  associateReview(review, undefined, { id: 'nearby', instruction: '', notes: [{ id: 'n1', page: 0, quote: '', comment: 'First', rects: [] }, { id: 'n2', page: 0, quote: '', comment: 'Second', rects: [] }], anchors: [{ noteId: 'n1', file: 'main.tex', line: 10, endLine: 10 }, { noteId: 'n2', file: 'main.tex', line: 12, endLine: 12 }] });
  assert.deepEqual(review.files[0].edits.map(edit => edit.noteIds), [['n1'], ['n2']]); review.files[0].edits[0].decision = 'accepted';
  assert.deepEqual([...resolvedNoteIds(review)], ['n1']);
});
