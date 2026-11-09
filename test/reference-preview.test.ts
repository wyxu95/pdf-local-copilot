import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PNG } from 'pngjs';
import { BuildManager } from '../src/build';
import { LivePreview } from '../src/live';
import { referenceKind, referenceLabel, referenceLinkAt, referencePreviewBounds } from '../src/reference-preview';

const source = String.raw`\documentclass{article}
\usepackage{libertine}
\usepackage[numbers]{natbib}
\usepackage[colorlinks=true]{hyperref}
\begin{document}
See the result~\cite{first,second}, Figure~\ref{fig:demo}, and Table~\ref{tab:demo}.
\clearpage
\begin{figure}[ht]
\centering\fbox{\rule{0pt}{90pt}\rule{180pt}{0pt}}
\caption{Sample figure caption.}\label{fig:demo}
\end{figure}
\begin{table}[ht]
\caption{Sample table caption.}\label{tab:demo}
\centering\begin{tabular}{lr}\hline
Name & Value\\\hline Alpha & 42\\ Beta & 21\\\hline
\end{tabular}
\end{table}
\clearpage
\begin{thebibliography}{9}
\bibitem[6]{first} Alice Author. 2026. First reference title. A detailed reference description for the hover preview.
\bibitem[11]{second} Bob Author. 2025. Second reference title. Another reference that must stay outside the first preview.
\end{thebibliography}
\end{document}
`;
for (const engine of ['xelatex', 'pdflatex'] as const) test(`reference links resolve and crop citations, figures and tables with real ${engine}`, { timeout: 60000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-reference-')), root = await fs.realpath(temp), main = path.join(root, 'main.tex');
  await fs.writeFile(main, source);
  const build = new BuildManager(root, main, engine, () => {}); let preview: LivePreview | undefined;
  try {
    const result = await build.build();
    preview = new LivePreview(path.resolve('native/texpresso'), root, main, { frame: () => {}, state: () => {}, log: () => {}, error: error => { throw error; } }, { includeDirectories: [build.directory], pdf: engine === 'xelatex' ? undefined : result.pdf });
    await preview.start(); const deadline = Date.now() + 20000;
    while (!preview.snapshot().complete) { if (Date.now() > deadline) throw new Error('Reference document did not finish rendering'); await new Promise(resolve => setTimeout(resolve, 30)); }
    const first = await preview.readPage(0), links = first.header.annotations?.links.filter(link => link.uri.startsWith('#')) || [];
    assert.ok(links.length >= 3, 'Rendered page has no internal reference links');
    const kinds = new Set<string>();
    for (const link of links) {
      assert.ok(referenceLinkAt(first.header, (link.bounds[0] + link.bounds[2]) / 2, (link.bounds[1] + link.bounds[3]) / 2));
      const { frame, target } = await preview.reference(link), kind = referenceKind(target.name); kinds.add(kind);
      const image = PNG.sync.read(frame.bytes), raster = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
      const bounds = referencePreviewBounds(frame.header, target, kind, raster), text = referenceLabel(frame.header, bounds);
      if (kind === 'Reference') {
        const number: string = target.name === 'cite.first' ? '6' : '11', title = number === '6' ? 'First reference title' : 'Second reference title';
        assert.equal(target.page, 2); assert.equal(referenceLabel(first.header, link.bounds), number);
        for (const char of first.header.characters!.filter(char => char[0] >= 48 && char[0] <= 57 && (char[1] + char[3]) / 2 >= link.bounds[0] && (char[1] + char[3]) / 2 <= link.bounds[2] && (char[2] + char[4]) / 2 >= link.bounds[1] && (char[2] + char[4]) / 2 <= link.bounds[3])) for (const fraction of [.1, .5, .9])
          assert.equal(referenceLinkAt(first.header, char[1] + (char[3] - char[1]) * fraction, (char[2] + char[4]) / 2)?.link.uri, link.uri, 'Hovering a digit selected the adjacent citation');
        assert.ok(text.includes(title), text); assert.ok(!text.includes(number === '6' ? 'Second reference title' : 'First reference title') && !text.includes('References'), text);
      }
      if (kind === 'Figure') { assert.equal(target.page, 1); assert.ok(text.includes('Sample') && text.includes('caption'), text); assert.ok(bounds[3] - bounds[1] >= 90, 'Figure graphic was cropped out'); assert.ok(bounds[2] - bounds[0] >= 180, 'Figure sides were cropped out'); }
      if (kind === 'Table') { assert.equal(target.page, 1); assert.ok(text.includes('Sample table caption') && text.includes('Alpha') && text.includes('Beta'), text); }
    }
    assert.deepEqual([...kinds].sort(), ['Figure', 'Reference', 'Table']);
  } finally { await preview?.stop(); await build.stop(); await fs.rm(temp, { recursive: true, force: true }); }
});
