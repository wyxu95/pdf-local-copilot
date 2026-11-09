import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horizontalCrop, inkBounds, surfaceTransform, sourcePoint, nearestTextPoint, textContext, textLines, textCaret } from '../src/view-geometry';
test('cropping enlarges horizontal content while preserving full-page coordinates', () => {
  const page: [number, number, number, number] = [0, 0, 600, 800];
  const crop = horizontalCrop(page, [80, 40, 520, 760]); assert.deepEqual(crop, [70, 0, 530, 800]);
  const transform = surfaceTransform(page, crop); assert.ok(transform.width > 100);
  assert.deepEqual(sourcePoint(page, { left: -40, top: 50, width: 1200, height: 1600 }, 200, 450), [120, 200]);
  assert.deepEqual(horizontalCrop(page), page);
});
test('ink measurement preserves figures wider than the text block', () => {
  const data = new Uint8ClampedArray(100 * 100 * 4).fill(255);
  data[(50 * 100 + 1) * 4] = 0; data[(50 * 100 + 98) * 4] = 0;
  const page: [number, number, number, number] = [0, 0, 600, 800];
  assert.deepEqual(horizontalCrop(page, inkBounds(page, 100, 100, data)), page);
});
test('source clicks in blank space snap to the closest ink rectangle, independent of drawing order', () => {
  const chars: [number, number, number, number, number][] = [[84, 10, 10, 30, 25], [32, 60, 100, 90, 114], [66, 100, 100, 108, 114], [65, 70, 100, 78, 114], [10, 0, 0, 0, 0]];
  assert.deepEqual(nearestTextPoint(chars, 80, 107), [74, 107]);
  assert.deepEqual(nearestTextPoint(chars, 73, 98), [74, 107]);
  assert.deepEqual(nearestTextPoint(chars, 73, 105), [73, 105]);
  assert.deepEqual(nearestTextPoint(chars, 112, 107), [104, 107]);
  assert.equal(nearestTextPoint([], 10, 10), undefined);
});
test('margin line numbers do not divert source clicks away from nearby body text', () => {
  const chars: [number, number, number, number, number][] = [[57, 20, 100, 25, 108], [10, 0, 0, 0, 0]];
  [...'hello,hello, Injection vulnerabilities'].forEach((c, i) => chars.push([c.codePointAt(0)!, 50 + i * 6, 100, 56 + i * 6, 112]));
  const point = nearestTextPoint(chars, 32, 106)!; assert.deepEqual(point, [53, 106]);
  const context = textContext(chars, ...point)!; assert.deepEqual(context, { words: ['hello', 'hello', 'injection', 'vulnerabilities'], index: 0 });
});
test('dragging past AUTHOR(S) stays on its line even when title glyphs follow it in drawing order', () => {
  const chars: [number, number, number, number, number][] = [];
  for (const [text, y] of [['ANONYMOUS AUTHOR(S)', 100], ['Paper title above the author', 30]] as const) {
    [...text].forEach((c, i) => chars.push([c.codePointAt(0)!, 70 + i * 7, y, 77 + i * 7, y + 14])); chars.push([10, 0, 0, 0, 0]);
  }
  const lines = textLines(chars), caret = textCaret(lines, 400, 108)!;
  assert.equal(caret.line, lines[0]); assert.equal(caret.offset, lines[0].glyphs.length);
  assert.equal(textCaret(lines, 400, 35)!.line, lines[1]);
});
test('drag endpoints clamp to the nearest visual line through gaps and outside both page edges', () => {
  const chars: [number, number, number, number, number][] = [];
  for (const [text, y] of [['Title', 20], ['First paragraph line', 100], ['Second paragraph line', 120]] as const) {
    [...text].forEach((c, i) => chars.push([c.codePointAt(0)!, 70 + i * 7, y, 77 + i * 7, y + 14])); chars.push([10, 0, 0, 0, 0]);
  }
  const lines = textLines(chars);
  for (const y of [108, 115]) { const caret = textCaret(lines, 700, y)!; assert.equal(caret.line, lines[1]); assert.equal(caret.offset, lines[1].glyphs.length); }
  const next = textCaret(lines, 700, 118)!; assert.equal(next.line, lines[2]); assert.equal(next.offset, lines[2].glyphs.length);
  const reverse = textCaret(lines, -20, 108)!; assert.equal(reverse.line, lines[1]); assert.equal(reverse.offset, 0);
  assert.equal(textCaret([], 0, 0), undefined);
});
test('a paragraph drag stays in its text column instead of selecting margin line numbers', () => {
  const chars: [number, number, number, number, number][] = [];
  for (const [text, x, y] of [['1', 20, 100], ['2', 20, 120], ['First line', 70, 100], ['Next line', 70, 120]] as const) {
    [...text].forEach((c, i) => chars.push([c.codePointAt(0)!, x + i * 7, y, x + (i + 1) * 7, y + 14])); chars.push([10, 0, 0, 0, 0]);
  }
  const lines = textLines(chars), caret = textCaret(lines, 0, 125, lines[2])!;
  assert.equal(caret.line, lines[3]); assert.equal(caret.offset, 0);
});
