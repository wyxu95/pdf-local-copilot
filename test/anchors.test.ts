import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackNotes, quoteGeometry, regionGeometry, locateAnnotation } from '../src/anchors';
import type { Note } from '../src/agent';
import type { Frame } from '../src/protocol';

const frame = (page: number, text: string, y = 200): Frame => ({ bytes: Buffer.alloc(0), header: { requestId: 1, page, sequence: 1, revision: 1, bounds: [0, 0, 600, 800], width: 600, height: 800, byteLength: 0, mime: 'image/png', characters: [...text].map((c, i) => [c.codePointAt(0)!, i * 5, y, i * 5 + 5, y + 10]) } });
test('reloading a macro annotation finds its quoted passage across pages despite the macro source pointing to the title', async () => {
  const note: Note = { id: 'macro', page: 0, quote: 'Underlying pointer analysis hypothesis.', comment: 'Remove this hypothesis', rects: [[20, 50, 150, 60]], source: { file: 'paper.tex', line: 80, text: '[Wenyuan: #1]' } };
  const frames = [frame(0, 'Paper title', 50), frame(1, 'Other section'), frame(2, note.quote, 350)];
  const location = await locateAnnotation(note, { page: 0, x: 20, y: 50 }, 3, async page => frames[page]);
  assert.equal(location?.page, 2); assert.equal(location?.rects[0][1], 350);
  assert.equal((await locateAnnotation(note, undefined, 3, async page => frames[page]))?.page, 2);
});
test('a removed passage keeps its annotation without attaching it to unrelated title text', async () => {
  const note: Note = { id: 'removed', page: 0, quote: 'Hypothesis which was removed.', comment: 'Remove', rects: [[10, 20, 100, 30]] };
  assert.equal(await locateAnnotation(note, { page: 0, x: 10, y: 20 }, 1, async () => frame(0, 'Paper title')), undefined);
  assert.deepEqual(note.rects, [[10, 20, 100, 30]]);
});
test('quoted text matches after line-end hyphenation and ligatures change on reload', () => {
  assert.ok(quoteGeometry(frame(0, 'Hypothesis confirmed').header, 'Hy-\npothesis conﬁrmed'));
  assert.ok(quoteGeometry(frame(0, 'Hy-\npothesis confirmed').header, 'Hypothesis confirmed'));
});
test('annotations retain identity and follow a source passage moved to a different line', () => {
  const notes: Note[] = [{ id: 'n', page: 0, rects: [[10, 10, 20, 20]], quote: 'Target sentence', comment: 'Clarify', source: { file: 'chapter.tex', line: 2, endLine: 2, text: 'Target sentence', anchor: 'Target sentence' } }];
  trackNotes(notes, 'chapter.tex', 'Heading\nTarget sentence\nEnding', 'New introduction\nHeading\nTarget sentence\nEnding');
  assert.equal(notes[0].id, 'n'); assert.equal(notes[0].source!.line, 3); assert.equal(notes[0].anchorStatus, 'anchored');
  const chars = [...'Target sentence'].map((c, i) => [c.codePointAt(0)!, i * 5, 200, i * 5 + 5, 210] as [number, number, number, number, number]);
  assert.deepEqual(quoteGeometry({ requestId: 1, page: 2, sequence: 1, revision: 1, bounds: [0, 0, 600, 800], width: 600, height: 800, byteLength: 1, mime: 'image/png', characters: chars }, notes[0].quote), [[0, 200, 75, 210]]);
});
test('a figure region keeps its dimensions relative to the moved source anchor', () => {
  const note: Note = { id: 'figure', page: 0, quote: '', comment: 'Update chart', rects: [[20, 30, 220, 130]], region: { dx: -5, dy: -10, width: 200, height: 100 } };
  assert.deepEqual(regionGeometry({ requestId: 1, page: 2, sequence: 1, revision: 1, bounds: [0, 0, 600, 800], width: 600, height: 800, byteLength: 1, mime: 'image/png' }, note, 100, 200), [[95, 190, 295, 290]]);
});
