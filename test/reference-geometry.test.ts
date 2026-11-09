import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FrameHeader } from '../src/protocol';
import { referenceKind, referenceLabel, referenceLinkAt, referencePreviewBounds } from '../src/reference-preview';

function bibliography(): FrameHeader {
  const characters: NonNullable<FrameHeader['characters']> = [];
  for (const [text, x, y] of [['References', 50, 30], ['[1] First entry', 50, 60], ['Continued text', 60, 74], ['[2] Second entry', 50, 100], ['[3] Other column', 330, 60], ['Another continuation', 340, 74], ['[4] Final entry', 330, 100]] as const) {
    [...text].forEach((c, i) => characters.push([c.codePointAt(0)!, x + i * 5, y, x + i * 5 + 5, y + 10]));
    characters.push([10, 0, 0, 0, 0]);
  }
  return { requestId: 1, sequence: 1, revision: 1, page: 1, bounds: [0, 0, 600, 800], width: 600, height: 800, mime: 'image/png', byteLength: 1, characters, annotations: { links: [], destinations: [{ name: 'cite.first', x: 60, y: 51 }, { name: 'cite.second', x: 60, y: 91 }, { name: 'cite.third', x: 340, y: 51 }, { name: 'cite.fourth', x: 340, y: 91 }] } };
}
test('bibliography crops include continuation lines and stay in the target column', () => {
  const header = bibliography();
  for (const target of [header.annotations!.destinations![0], header.annotations!.destinations![2]]) {
    const bounds = referencePreviewBounds(header, target, 'Reference'), text = referenceLabel(header, bounds);
    assert.ok(text.includes(target.name === 'cite.first' ? 'First entryContinued text' : 'Other columnAnother continuation'), text);
    assert.ok(!text.includes('References') && !text.includes('Second entry') && !text.includes('Final entry'), text);
    assert.ok(target.x < 300 ? bounds[2] < 330 : bounds[0] > 300);
  }
});
test('link hit testing ignores external URLs and classifies figure and table targets', () => {
  const header = bibliography();
  header.annotations!.links = [{ bounds: [20, 20, 40, 30], uri: 'https://example.invalid/' }, { bounds: [60, 20, 80, 30], uri: '#cite.first' }];
  assert.equal(referenceLinkAt(header, 30, 25), undefined);
  assert.equal(referenceLinkAt(header, 70, 25)?.index, 1);
  assert.equal(referenceLinkAt(header, 90, 25), undefined);
  assert.equal(referenceKind('figure.2'), 'Figure'); assert.equal(referenceKind('subfigure.2a'), 'Figure');
  assert.equal(referenceKind('table.caption.3'), 'Table'); assert.equal(referenceKind('cite.first'), 'Reference');
});
