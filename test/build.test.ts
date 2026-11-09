import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BuildManager, resolveMain, engineFor } from '../src/build';
import { externalPosition, externalLocation } from '../src/synctex';
import { LivePreview } from '../src/live';
test('magic roots, BibTeX builds, and external SyncTeX work with real TeX Live', { timeout: 60000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-build-')); const root = await fs.realpath(temp);
  const main = path.join(root, 'main.tex');
  await fs.writeFile(main, '% !TeX program = pdflatex\n\\documentclass{article}\n\\begin{document}\nA cited result \\cite{sample}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n');
  await fs.writeFile(path.join(root, 'chapter.tex'), '% !TeX root = main.tex\nSome chapter.');
  await fs.writeFile(path.join(root, 'refs.bib'), '@article{sample, author={Test Author}, title={A Resolved Citation}, journal={Test Journal}, year={2024}}');
  const build = new BuildManager(root, main, await engineFor(main), () => {});
  try {
    assert.deepEqual(await resolveMain(path.join(root, 'chapter.tex'), root), [main]);
    const result = await build.build(); assert.equal(result.engine, 'pdflatex');
    assert.ok((await fs.readFile(path.join(build.directory, 'main.bbl'), 'utf8')).toLowerCase().includes('resolved'));
    const point = await externalPosition(result.pdf, main, 4, root);
    const source = await externalLocation(result.pdf, point.page, point.x, point.y, root);
    assert.equal(source.file, main); assert.ok(source.line >= 3);
    const before = await fs.readFile(result.pdf);
    await fs.writeFile(main, '\\documentclass{article}\n\\begin{document}\\undefinedcommand\\end{document}');
    await assert.rejects(build.build(), /构建失败/); assert.deepEqual(await fs.readFile(result.pdf), before, 'A failed build replaced the last valid PDF');
  } finally { await build.stop(); await fs.rm(temp, { recursive: true, force: true }); }
});
test('Biber, project pre-build steps, and the PDF preview backend work together', { timeout: 90000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-biber-')), root = await fs.realpath(temp), main = path.join(root, 'main.tex');
  await fs.writeFile(main, '% !TeX program = lualatex\n\\documentclass{article}\n\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\nVisual paper with citation \\cite{sample}.\n\\printbibliography\n\\end{document}\n');
  await fs.writeFile(path.join(root, 'refs.bib'), '@article{sample, author={Test Author}, title={A Biber Reference}, journaltitle={Test Journal}, date={2024}}');
  const build = new BuildManager(root, main, await engineFor(main), () => {}, [{ command: process.execPath, args: ['-e', 'require("fs").writeFileSync("generated.txt", "pre-build ran")'] }]);
  let preview: LivePreview | undefined;
  try {
    const result = await build.build(); assert.equal(result.engine, 'lualatex'); assert.equal(await fs.readFile(path.join(root, 'generated.txt'), 'utf8'), 'pre-build ran');
    assert.match(await fs.readFile(path.join(build.directory, 'main.bbl'), 'utf8'), /sample/);
    let ready!: () => void; const first = new Promise<void>(resolve => { ready = resolve; });
    preview = new LivePreview(path.resolve('native/texpresso'), root, main, { frame: () => ready(), state: () => {}, log: () => {}, error: e => { throw e; } }, { pdf: result.pdf });
    await preview.start(); await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error('PDF backend did not render.')), 10000))]);
    const position = await preview.position(main, 6); assert.equal(position.page, 0);
    const location = await preview.locate(preview.lastFrame!.header, position.x, position.y); assert.equal(location.file, main);
  } finally { await preview?.stop(); await build.stop(); await fs.rm(temp, { recursive: true, force: true }); }
});
