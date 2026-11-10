import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FrameDelivery } from '../src/frame-delivery';
import { restoreFrame } from '../src/frame-cache';
import { LivePreview } from '../src/live';
import type { Frame } from '../src/protocol';

const frame = (revision = 1, bytes = Buffer.from('same page image')): Frame => ({ bytes, header: { requestId: revision, revision, sequence: revision, page: 0, bounds: [0, 0, 600, 800], width: 600, height: 800, mime: 'image/png', byteLength: bytes.length, characters: [[65, revision, 10, revision + 10, 20]], annotations: { links: [{ bounds: [revision, 10, 20, 20], uri: '#cite.test' }] } } });

test('five identical images transfer once while every text, link and source revision reaches the reader', () => {
  const delivery = new FrameDelivery('reader'); let previous: ReturnType<typeof delivery.encode> | undefined, images = 0;
  for (let revision = 1; revision <= 5; revision++) {
    const source = frame(revision), message = delivery.encode('frame', 'before', 1, source);
    if (message.data !== undefined) images++;
    const restored = restoreFrame(message, previous); assert.ok(restored);
    assert.deepEqual(Buffer.from(restored.data, 'base64'), source.bytes);
    assert.deepEqual(restored.header, source.header, 'Image reuse lost the new coordinates or source revision');
    previous = restored;
  }
  assert.equal(images, 1);
});
test('changed images, new pages, preview sessions and separate readers each receive a complete image', () => {
  const delivery = new FrameDelivery('reader'), first = delivery.encode('frame', 'before', 1, frame());
  const changed = delivery.encode('frame', 'before', 1, frame(2, Buffer.from('changed pixels')));
  assert.notEqual(changed.imageId, first.imageId); assert.ok(changed.data);
  assert.ok(delivery.encode('frame', 'before', 2, frame()).data);
  const anotherPage = frame(); anotherPage.header.page = 1;
  assert.ok(delivery.encode('pageFrame', 'before', 2, anotherPage).data);
  assert.ok(delivery.encode('frame', 'after', 2, frame()).data);
  const reloaded = new FrameDelivery('new reader').encode('frame', 'before', 2, frame());
  assert.ok(reloaded.data); assert.equal(reloaded.viewId, 'new reader');
});
test('layout updates are distinguished from repeated exports of the same image and geometry', () => {
  const delivery = new FrameDelivery('reader'), first = delivery.encode('frame', 'before', 1, frame());
  const repeated = frame(); repeated.header.requestId++;
  assert.equal(delivery.encode('frame', 'before', 1, repeated).layoutId, first.layoutId);
  repeated.header.characters![0][1] += 5;
  const moved = delivery.encode('frame', 'before', 1, repeated);
  assert.equal(moved.imageId, first.imageId); assert.equal(moved.data, undefined); assert.notEqual(moved.layoutId, first.layoutId);
});
test('an evicted or missing image is detected and a full-page retry restores current metadata', () => {
  const delivery = new FrameDelivery('reader'), first = delivery.encode('frame', 'before', 1, frame());
  const update = delivery.encode('pageFrame', 'before', 1, frame(2)); assert.equal(update.data, undefined);
  assert.equal(restoreFrame(update), undefined);
  assert.equal(restoreFrame(update, { imageId: 'different image', data: 'old' }), undefined);
  delivery.forget('before', 0);
  const retry = delivery.encode('pageFrame', 'before', 1, frame(2), true);
  assert.deepEqual(restoreFrame(retry)?.header, frame(2).header);
  assert.equal(restoreFrame(update, first)?.data, first.data);
  for (let page = 1; page <= 17; page++) { const next = frame(); next.header.page = page; delivery.encode('pageFrame', 'before', 1, next); }
  assert.ok(delivery.encode('pageFrame', 'before', 1, frame()).data, 'The sender retained unbounded old page references');
});
test('comment-only TeX edits reuse the actual image and retain the new SyncTeX source line', { timeout: 45000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-reuse-')), root = await fs.realpath(temporary), main = path.join(root, 'main.tex');
  const source = '\\documentclass{article}\n\\begin{document}\nStable passage for source synchronization.\n\\end{document}\n';
  await fs.writeFile(main, source);
  const delivery = new FrameDelivery('native reader'); let latest: Frame | undefined;
  const preview = new LivePreview(path.resolve('native/texpresso'), root, main, { frame: f => { latest = f; }, state: () => {}, log: () => {}, error: () => {} });
  const settled = async (sequence?: number) => {
    const deadline = Date.now() + 20000;
    while (!latest || !preview.snapshot().complete || preview.snapshot().stale || sequence !== undefined && latest.header.sequence <= sequence) {
      assert.ok(Date.now() < deadline, 'No current preview'); await new Promise(resolve => setTimeout(resolve, 30));
    }
    return latest;
  };
  try {
    await preview.start(); const before = await settled();
    const first = delivery.encode('frame', 'before', 1, before);
    preview.update(main, source.replace('Stable passage', '% A source-only change moves the next line.\nStable passage'));
    const after = await settled(before.header.sequence), update = delivery.encode('frame', 'before', 1, after);
    assert.equal(update.data, undefined, 'A source-only change retransmitted identical image pixels');
    const restored = restoreFrame(update, first)!; assert.ok(restored.header.sequence > first.header.sequence);
    const character = restored.header.characters!.find(c => c[0] === 83)!;
    const location = await preview.locate(restored.header, (character[1] + character[3]) / 2, (character[2] + character[4]) / 2);
    assert.equal(location.file, main); assert.equal(location.line, 4);
  } finally { await preview.stop(); await fs.rm(temporary, { recursive: true, force: true }); }
});
