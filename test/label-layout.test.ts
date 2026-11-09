import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOverlayLabels, type Bounds } from '../src/view-geometry';
test('labels avoid body text and each other while preferring the position above their anchor', () => {
  const labels = [{ x: 80, y: 58, width: 22, height: 18, fallbackX: 304 }, { x: 80, y: 58, width: 22, height: 18, fallbackX: 304 }, { x: 200, y: 15, width: 22, height: 18, fallbackX: 304 }];
  const text: Bounds[] = [[0, 50, 280, 80]], positions = placeOverlayLabels(labels, text, 300, 400);
  const boxes = positions.map((position, i) => [position.x, position.y, position.x + labels[i].width, position.y + labels[i].height] as Bounds);
  const overlaps = (a: Bounds, b: Bounds) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  assert.deepEqual(positions[2], { x: 200, y: 15 });
  boxes.forEach((box, i) => { assert.ok(!text.some(rect => overlaps(box, rect))); assert.ok(!boxes.slice(0, i).some(rect => overlaps(box, rect))); assert.ok(box[1] >= 0 && box[3] <= 400); });
});
