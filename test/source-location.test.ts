import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineSourceLocation } from '../src/source-location';

test('a unique clicked phrase corrects a SyncTeX hint pointing at an unrelated layout line', () => {
  const lines = Array.from({ length: 320 }, () => ''); lines[145] = 'hello,hello,'; lines[310] = '\\item Research question two';
  assert.deepEqual(refineSourceLocation(lines.join('\n'), 311, -1, 'hello,hello,'), { line: 145, column: 0, length: 12 });
});
test('repeated words use the local SyncTeX context; ambiguous distant matches keep the hint', () => {
  const lines = Array.from({ length: 100 }, () => ''); lines[10] = 'The scanner'; lines[50] = 'Another scanner';
  assert.deepEqual(refineSourceLocation(lines.join('\n'), 51, 0, 'scanner'), { line: 50, column: 8, length: 7 });
  assert.deepEqual(refineSourceLocation(lines.join('\n'), 90, 2, 'scanner'), { line: 89, column: 0, length: 0 });
});
test('word refinement respects word boundaries and clamps missing source coordinates', () => {
  assert.deepEqual(refineSourceLocation('metadata\n  data', 1, -1, 'data'), { line: 1, column: 2, length: 4 });
  assert.deepEqual(refineSourceLocation('text', 99, 99), { line: 0, column: 4, length: 0 });
});
test('surrounding PDF words override a wrong hint even when the clicked word occurs near that hint', () => {
  const text = 'A scanner compares unrelated configurations.\n% A scanner tracks vulnerable data.\nA \\textbf{scanner} tracks vulnerable data.\nAnother scanner changes the design.';
  const context = { words: ['a', 'scanner', 'tracks', 'vulnerable', 'data'], index: 1 };
  assert.deepEqual(refineSourceLocation(text, 4, 8, 'scanner', context), { line: 2, column: 10, length: 7 });
});
