import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BuildManager } from '../src/build';
import { LivePreview } from '../src/live';

const title = 'Abusing Hidden Properties to Attack the Node.js Ecosystem.';
for (const engine of ['xelatex', 'pdflatex'] as const) test(`Libertine ligatures retain copyable text and character geometry with ${engine}`, { timeout: 60000 }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-unicode-')), root = await fs.realpath(temporary), main = path.join(root, 'main.tex');
  await fs.writeFile(main, String.raw`\documentclass{article}\usepackage{libertine}\begin{document}
${title}
Effective efficient office difficult affinity float conflict structure attractive.
\textit{${title}}
\textbf{${title}}
\end{document}`);
  const build = new BuildManager(root, main, engine, () => {}); let preview: LivePreview | undefined;
  try {
    const result = await build.build();
    preview = new LivePreview(path.resolve('native/texpresso'), root, main, { frame: () => {}, state: () => {}, log: () => {}, error: error => { throw error; } }, { includeDirectories: [build.directory], pdf: engine === 'xelatex' ? undefined : result.pdf });
    await preview.start(); const deadline = Date.now() + 20000;
    while (!preview.snapshot().complete) { assert.ok(Date.now() < deadline, 'Rendering timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
    const { header } = await preview.readPage(0), characters = header.characters!, text = characters.map(c => String.fromCodePoint(c[0])).join('').replace(/\s+/g, ' ');
    assert.equal(text.split(title).length - 1, 3, text);
    assert.ok(text.includes('Effective efficient office difficult affinity float conflict structure attractive.'), text);
    assert.ok(!text.includes('\u0000') && !text.includes('�'), text);
    const glyphs = characters.filter(c => c[0] !== 10), index = glyphs.map(c => String.fromCodePoint(c[0])).join('').indexOf('Attack');
    const first = glyphs[index + 1], second = glyphs[index + 2];
    assert.ok(first[3] > first[1] && second[3] > second[1] && first[3] <= second[1] + .01, 'The tt ligature has overlapping or empty selection boxes');
  } finally { await preview?.stop(); await build.stop(); await fs.rm(temporary, { recursive: true, force: true }); }
});
