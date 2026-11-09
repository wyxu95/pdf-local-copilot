import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LivePreview } from '../src/live';
import type { Frame } from '../src/protocol';

test('real TeXpresso renders text, resolves SyncTeX, applies unsaved edits and disk rescans', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-native-'));
  const main = path.join(dir, 'main.tex');
  const source = '\\documentclass{article}\n\\begin{document}\nInitial passage for live annotation.\n\\end{document}\n';
  await fs.writeFile(main, source);
  let frame: Frame | undefined, notify: ((value: Frame) => void) | undefined;
  const errors: Error[] = []; let log = '';
  const preview = new LivePreview(path.resolve('native/texpresso'), dir, main, {
    frame: f => { frame = f; notify?.(f); }, state: () => {}, log: s => { log += s; }, error: e => errors.push(e)
  });
  async function next(predicate: (f: Frame) => boolean) {
    if (frame && predicate(frame)) return frame;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No matching frame. Errors: ${errors.map(e => e.message).join('; ')}\n${log.slice(-5000)}`)), 20000);
      notify = f => { if (predicate(f)) { clearTimeout(timer); notify = undefined; resolve(f); } };
    });
  }
  const text = (f: Frame) => (f.header.characters || []).map(c => String.fromCodePoint(c[0])).join('');
  try {
    await preview.start();
    const first = await next(f => text(f).includes('Initial passage'));
    assert.equal(first.bytes.subarray(1, 4).toString(), 'PNG');
    const c = first.header.characters!.find(c => c[0] === 'I'.codePointAt(0))!;
    const location = await preview.locate(first.header, (c[1] + c[3]) / 2, (c[2] + c[4]) / 2);
    assert.equal(location.file, main); assert.ok(location.line >= 2 && location.line <= 3);
    const point = await preview.position(main, 3); assert.equal(point.page, 0);
    const crop = await preview.capture(0, [c[1] - 2, c[2] - 2, c[3] + 80, c[4] + 2]);
    assert.equal(crop.bytes.subarray(1, 4).toString(), 'PNG'); assert.ok(crop.header.bounds[2] - crop.header.bounds[0] < 100);
    preview.update(main, source.replace('Initial passage', 'Unsaved revision'));
    const unsaved = await next(f => f.header.sequence > first.header.sequence && text(f).includes('Unsaved revision'));
    assert.equal(await fs.readFile(main, 'utf8'), source);
    await assert.rejects(preview.locate(first.header, 100, 100), /preview is updating/i);
    preview.closeBuffer(main);
    await fs.writeFile(main, source.replace('Initial passage', 'Disk revision'));
    preview.rescan();
    const disk = await next(f => f.header.sequence > unsaved.header.sequence && text(f).includes('Disk revision'));
    await fs.mkdir('output', { recursive: true }); await fs.writeFile('output/native-page.png', disk.bytes);
    assert.deepEqual(errors, []);
  } finally { await preview.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});
