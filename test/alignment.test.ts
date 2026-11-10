import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LivePreview } from '../src/live';
import { mapLine } from '../src/review';
test('source alignment finds the same passage after it moves to another PDF page', { timeout: 45000 }, async context => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-alignment-'));
  const before = '\\documentclass{article}\n\\begin{document}\nA preface.\nTarget passage for cross page review.\n\\end{document}\n';
  const after = before.replace('Target passage', '\\newpage\nTarget passage');
  const previews: LivePreview[] = [];
  const diagnostics: string[] = [];
  try {
    for (const [side, content] of [['before', before], ['after', after]]) {
      const root = path.join(temp, side); await fs.mkdir(root); const main = path.join(root, 'main.tex'); await fs.writeFile(main, content);
      const p = new LivePreview(path.resolve('native/texpresso'), root, main, { frame: f => diagnostics.push(`${side} frame ${JSON.stringify(f.header)}`), state: s => diagnostics.push(`${side} state ${JSON.stringify(s)}`), log: s => diagnostics.push(`${side} ${s}`), error: e => diagnostics.push(`${side} error ${e.message}`) }); previews.push(p); await p.start();
    }
    const a = await previews[0].position(path.join(temp, 'before/main.tex'), 4);
    const mapped = mapLine(before, after, 4); const b = await previews[1].position(path.join(temp, 'after/main.tex'), mapped.line);
    assert.equal(a.page, 0); assert.equal(b.page, 1);
    const frame = await previews[1].readPage(b.page); assert.equal(frame.header.page, 1);
    assert.match((frame.header.characters || []).map(c => String.fromCodePoint(c[0])).join(''), /Target passage/);
    const pendingCrop = previews[1].capture(0, [0, 0, 200, 200]);
    const active = await previews[1].activatePage(1, frame.header.sequence);
    const location = await previews[1].locate(active, b.x + 2, b.y);
    await pendingCrop;
    assert.equal(await fs.realpath(location.file), await fs.realpath(path.join(temp, 'after/main.tex')));
  } catch (error) { context.diagnostic(diagnostics.join('\n').slice(-16000)); throw error; }
  finally { await Promise.all(previews.map(p => p.stop())); await fs.rm(temp, { recursive: true, force: true }); }
});
