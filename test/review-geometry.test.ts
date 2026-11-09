import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignReviewSource } from '../src/review-geometry';
import type { FrameHeader } from '../src/protocol';

function page(number: number, lines: string[]): FrameHeader {
  const characters: NonNullable<FrameHeader['characters']> = [];
  lines.forEach((line, row) => {
    const y = 50 + row * 20;
    characters.push([49 + row, 10, y, 15, y + 10], [10, 0, 0, 0, 0]);
    [...line].forEach((c, i) => characters.push([c.codePointAt(0)!, 100 + i * 5, y, 105 + i * 5, y + 10]));
    characters.push([10, 0, 0, 0, 0]);
  });
  return { requestId: 1, sequence: 1, revision: 1, page: number, bounds: [0, 0, 700, 800], width: 700, height: 800, mime: 'image/png', byteLength: 0, characters };
}
test('changed paragraphs map across pages through citations, author macros and missing ligature glyphs', () => {
  const changed = `First, false alarms can be estimated indirectly.\nSecond, mislabeled cases are confirmed by other works~\\cite{EfficientStatic2024,XjsLive2026}.\nThird, \\wenyuan{confirm this} efficiency depends on interprocedural analysis.\nOn the evaluation side, each approach uses its own threat model.`;
  const prefix = '\\documentclass{article}\n\\begin{document}\nUnchanged introduction.\n';
  const source = prefix + changed + '\nUnchanged conclusion.\n\\end{document}';
  const headers = [page(0, ['Unchanged introduction.', 'First, false alarms can be estimated indirectly.', 'Second, mislabeled cases are confirmed by other works [1, 5].']), page(1, ['Third, [Wenyuan: confirm this] e\0ciency depends on interprocedural analysis.', 'On the evaluation side, each approach uses its own threat model.', 'Unchanged conclusion.'])];
  const ranges = alignReviewSource(source, headers)(prefix.length, changed.length);
  assert.deepEqual(ranges.map(range => range.page), [0, 1]);
  assert.equal(ranges[0].rects[0][1], 70); assert.equal(ranges[1].rects.at(-1)![3], 80);
  assert.ok(ranges.every(range => range.rects.every(rect => rect[0] >= 100)), 'Red margin line numbers were highlighted');
  assert.ok(ranges.reduce((n, range) => n + range.rects.length, 0) >= 4);
});
test('a short replacement highlights only its own words within the paragraph', () => {
  const source = 'Before this sentence. Some cases are mislabeled in the benchmark. After this sentence.';
  const header = page(0, ['Before this sentence.', 'Some cases are mislabeled in the benchmark.', 'After this sentence.']);
  const ranges = alignReviewSource(source, [header])(source.indexOf('are mislabeled'), 'are mislabeled'.length);
  assert.equal(ranges.length, 1); assert.equal(ranges[0].rects.length, 1);
  assert.equal(ranges[0].rects[0][0], 100 + 'Some cases '.length * 5);
  assert.equal(ranges[0].rects[0][2], 100 + 'Some cases are mislabeled'.length * 5);
});
test('an invisible edit has no unrelated whole-line fallback', () => {
  const source = '\\label{internal-label}\nVisible paragraph.';
  assert.deepEqual(alignReviewSource(source, [page(0, ['Visible paragraph.'])])(0, '\\label{internal-label}'.length), []);
});
