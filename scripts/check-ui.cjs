const { chromium } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
let browser, page;
(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9339'); page = browser.contexts()[0].pages()[0];
  await fs.mkdir('output/playwright', { recursive: true });
  async function until(check, timeout = 45000) { const deadline = Date.now() + timeout; while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for UI state'); await new Promise(r => setTimeout(r, 100)); } }
  const input = () => page.locator('.quick-input-widget:visible input').first();
  async function command(title) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.getByRole('button', { name: 'Open Quick Access', exact: true }).click();
      try { await input().waitFor({ timeout: 1200 }); break; } catch (e) { if (attempt === 3) throw e; await page.keyboard.press('Escape'); }
    }
    await input().fill(`>PDF Local Copilot: ${title}`);
    const row = page.locator('.quick-input-widget:visible .monaco-list-row').filter({ hasText: `PDF Local Copilot: ${title}` }).first(); await row.waitFor(); await row.click();
  }
  async function showPaper() {
    const tab = page.getByRole('tab', { name: /^Paper(?:$| -)/ });
    if (await tab.getAttribute('aria-selected') !== 'true' || !await page.locator('.part.sidebar').isVisible()) await tab.click();
  }
  async function reviewItem(text, title = 'Current Changes') {
    const pane = page.locator('.pane').filter({ has: page.getByText(title, { exact: true }) });
    const header = pane.locator('.pane-header');
    if (await header.getAttribute('aria-expanded') === 'false') await header.click();
    const row = pane.getByRole('treeitem').filter({ hasText: text }).first();
    for (let attempt = 0; attempt < 12; attempt++) {
      const box = await pane.locator('.monaco-list').first().boundingBox();
      if (!box) { await new Promise(resolve => setTimeout(resolve, 120)); continue; }
      const item = await row.count() ? await row.boundingBox() : null;
      const clickable = item && item.y >= box.y && item.y + item.height <= box.y + box.height + 1 && await row.evaluate(element => { const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit === element || element.contains(hit); });
      if (clickable) return row;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, item ? item.y < box.y + 60 ? -80 : 80 : attempt === 0 ? -1000 : 160); await new Promise(resolve => setTimeout(resolve, 120));
    }
    return row;
  }
  const main = path.resolve('output/host/paper/main.tex'), original = await fs.readFile(main, 'utf8');
  await page.getByRole('button', { name: 'PDF Local Copilot: Open Paper', exact: true }).waitFor();
  await page.keyboard.press('Control+g'); await input().fill(':20'); await page.keyboard.press('Enter'); await input().waitFor({ state: 'hidden' });
  const sourceLine = () => page.locator('.view-line').filter({ hasText: 'Our approach makes the writing process' }).first();
  await sourceLine().click({ button: 'right' });
  await page.getByRole('menuitem', { name: /PDF Local Copilot: Go to PDF Location/ }).click();
  let frame;
  await until(async () => { for (const f of page.frames()) if (await f.locator('#paper .page-image').count().catch(() => 0)) { frame = f; return true; } return false; });
  await frame.waitForFunction(() => !document.querySelector('#paper').classList.contains('stale'));
  await frame.locator('#paper[data-crop-ready="true"]').waitFor();
  let chat;
  async function findChat() { await until(async () => { for (const f of page.frames()) if (await f.locator('body.chat-only #chat-agent option').count().catch(() => 0) > 1) { chat = f; return true; } return false; }); }
  await findChat();
  const migrated = JSON.parse(await fs.readFile(path.join(path.dirname(main), '.pdf-local-copilot/archives/legacy-review.json'), 'utf8'));
  assert.equal(migrated.review.files.length, 1); assert.equal(migrated.review.files[0].file, 'main.tex');
  assert.equal(Buffer.from(migrated.review.files[0].proposed, 'base64').toString(), 'Unapplied legacy proposal to archive.');
  assert.equal(await fs.readFile(main, 'utf8'), original, 'Migration overwrote the author’s real manuscript');
  await assert.rejects(fs.access(path.join('output/host/profile/User/globalStorage/local-paper-tools.pdf-local-copilot/tasks/legacy-review')), undefined, 'Retired global task copy was not removed after successful archival');
  const sourceTab = page.getByRole('tab', { name: /^main\.tex(?:,|$)/ }).last(); await sourceTab.waitFor();
  await sourceTab.click();
  const pdfBox = await frame.locator('body').boundingBox(), texBox = await sourceTab.boundingBox();
  assert.ok(texBox.x < pdfBox.x, 'PDF was not opened to the right of TeX');
  const chatBox = await chat.locator('body').boundingBox(); assert.ok(chatBox.x >= pdfBox.x + pdfBox.width - 3, 'Chat is not in a separate group to the right of the PDF');
  const sash = await page.locator('.monaco-sash.vertical').evaluateAll((nodes, x) => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, height: r.height }; }).filter(r => r.height > 400 && Math.abs(r.x - x) < 12).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0], chatBox.x);
  assert.ok(sash, 'Native chat group resize handle is missing');
  await page.mouse.move(sash.x, sash.y); await page.mouse.down(); await page.mouse.move(sash.x - 100, sash.y, { steps: 10 }); await page.mouse.up();
  await until(async () => (await chat.locator('body').boundingBox()).width >= chatBox.width + 70);
  await frame.locator('#paper .source-location').waitFor();
  await page.screenshot({ path: 'output/playwright/vscode-tex-to-pdf.png' });
  await frame.locator('#viewport').evaluate(v => { v.scrollTop = 0; });
  await page.screenshot({ path: 'output/playwright/vscode-right-pdf-layout.png' });
  // Crop must preserve the entire page in a translated surface and enlarge its body.
  await frame.waitForFunction(() => Number(document.querySelector('#paper').dataset.cropLeft) > 0);
  const geometry = await frame.evaluate(() => ({ paper: document.querySelector('#paper').getBoundingClientRect().width, surface: document.querySelector('#paper .page-surface').getBoundingClientRect().width }));
  assert.ok(geometry.surface > geometry.paper * 1.12, 'Margins were not cropped to enlarge text');
  await frame.waitForFunction(() => !document.querySelector('#paper').classList.contains('stale') && document.querySelector('#paper').dataset.cropReady === 'true');
  // Physical drag past AUTHOR(S) must stay on the author line, regardless of native DOM order.
  const author = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('#paper .text-layer span')], text = nodes.map(n => n.textContent).join(''), quote = 'ANONYMOUS AUTHOR(S)', index = text.indexOf(quote);
    if (index < 0) throw new Error('Anonymous author regression fixture is missing');
    const first = nodes[index].getBoundingClientRect(), last = nodes[index + quote.length - 1].getBoundingClientRect();
    return { x0: first.left + 1, y: (first.top + first.bottom) / 2, x1: last.right + 35 };
  });
  let offset = await frame.locator('body').boundingBox();
  await page.mouse.move(offset.x + author.x0, offset.y + author.y); await page.mouse.down(); await page.mouse.move(offset.x + author.x1, offset.y + author.y, { steps: 12 }); await page.mouse.up();
  const add = frame.locator('.selection-action'); await add.waitFor({ state: 'visible' });
  assert.equal((await add.getAttribute('title')).replace(/\s+/g, ' '), 'ANONYMOUS AUTHOR(S)');
  assert.equal((await frame.evaluate(() => window.getSelection().toString())).replace(/\s+/g, ' '), 'ANONYMOUS AUTHOR(S)');
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } }); await add.waitFor({ state: 'hidden' });
  // Moving outside a paragraph and through line gaps must preserve its anchor.
  const paragraph = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('#paper .text-layer span')], text = nodes.map(n => n.textContent).join('');
    const start = text.indexOf('Reading and editing'), ending = 'directly to the document.', end = text.indexOf(ending) + ending.length - 1;
    const first = nodes[start].getBoundingClientRect(), last = nodes[end].getBoundingClientRect(), paper = document.querySelector('#paper').getBoundingClientRect();
    return { x: first.left + 1, y: (first.top + first.bottom) / 2, gap: first.bottom + 2, endX: last.right + 2, endY: (last.top + last.bottom) / 2, right: paper.right + 20, left: paper.left + 1 };
  });
  await page.mouse.move(offset.x + paragraph.x, offset.y + paragraph.y); await page.mouse.down();
  for (const [x, y] of [[paragraph.right, paragraph.y], [paragraph.right, paragraph.gap], [paragraph.right, paragraph.endY], [paragraph.endX, paragraph.endY]]) {
    await page.mouse.move(offset.x + x, offset.y + y, { steps: 8 });
    const quote = await frame.evaluate(() => window.getSelection().toString());
    assert.ok(quote.startsWith('Reading and editing') && !quote.includes('A Paper You Can Talk To'), 'Dragging through blank space lost the paragraph anchor: ' + quote);
  }
  await page.mouse.up(); await add.waitFor({ state: 'visible' });
  const paragraphQuote = (await add.getAttribute('title')).replace(/\s+/g, ' ');
  assert.ok(paragraphQuote.startsWith('Reading and editing') && paragraphQuote.endsWith('directly to the document.'));
  // Reverse direction and leave the left edge while retaining the same paragraph.
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } });
  await page.mouse.move(offset.x + paragraph.endX, offset.y + paragraph.endY); await page.mouse.down();
  await page.mouse.move(offset.x + paragraph.left, offset.y + paragraph.y, { steps: 12 });
  await page.mouse.up(); await add.waitFor({ state: 'visible' });
  assert.equal((await add.getAttribute('title')).replace(/\s+/g, ' '), paragraphQuote);
  await page.screenshot({ path: 'output/playwright/vscode-paragraph-selection.png' });
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } }); await add.waitFor({ state: 'hidden' });
  async function selectPhrase(quote, pageNumber = 0) {
    await frame.waitForFunction(pageNumber => { const paper = document.querySelector(`.paper[data-page="${pageNumber}"]`); return paper?.querySelector('.page-image') && !paper.classList.contains('stale'); }, pageNumber);
    await frame.evaluate(({ quote, pageNumber }) => {
      const paper = document.querySelector(`.paper[data-page="${pageNumber}"]`), nodes = [...paper.querySelectorAll('.text-layer span')], text = nodes.map(n => n.textContent).join(''), index = text.indexOf(quote);
      if (index < 0) throw new Error('Passage missing: ' + quote);
      const range = document.createRange(); range.setStart(nodes[index].firstChild, 0); range.setEnd(nodes[index + quote.length - 1].firstChild, nodes[index + quote.length - 1].firstChild.textContent.length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); paper.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { quote, pageNumber });
    await add.waitFor({ state: 'visible' }); await add.click();
  }
  const copyPhrase = 'An effective attack on an efficient office workflow.';
  const selectionBox = await frame.evaluate(quote => {
    const nodes = [...document.querySelectorAll('#paper .text-layer span')], at = nodes.map(n => n.textContent).join('').indexOf(quote);
    if (at < 0) throw new Error('Ligature sample is missing or corrupted');
    nodes[at].scrollIntoView({ block: 'center' });
    const first = nodes[at].getBoundingClientRect(), last = nodes[at + quote.length - 1].getBoundingClientRect();
    return { left: first.left, top: first.top, right: last.right, bottom: first.bottom };
  }, copyPhrase);
  const beforeSelection = PNG.sync.read(await page.screenshot());
  const copiedText = await frame.evaluate(quote => {
    const nodes = [...document.querySelectorAll('#paper .text-layer span')], at = nodes.map(n => n.textContent).join('').indexOf(quote);
    const range = document.createRange(); range.setStart(nodes[at].firstChild, 0); range.setEnd(nodes[at + quote.length - 1].firstChild, 1);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    document.querySelector('#paper').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const data = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  }, copyPhrase);
  assert.equal(copiedText, copyPhrase);
  await add.waitFor({ state: 'visible' }); await frame.locator('#paper .text-selection path').waitFor();
  assert.equal(await frame.locator('#paper .text-selection path').count(), 1);
  assert.equal(await frame.locator('#paper .text-layer span').first().evaluate(span => getComputedStyle(span, '::selection').backgroundColor), 'rgba(0, 0, 0, 0)');
  const afterSelection = PNG.sync.read(await page.screenshot({ path: 'output/playwright/vscode-unicode-selection.png' }));
  const selectionOffset = await frame.locator('body').boundingBox(), pixelScale = beforeSelection.width / await page.evaluate(() => innerWidth);
  const shades = [];
  for (let y = Math.ceil((selectionOffset.y + selectionBox.top + 2) * pixelScale); y < (selectionOffset.y + selectionBox.bottom - 2) * pixelScale; y++) for (let x = Math.ceil((selectionOffset.x + selectionBox.left + 2) * pixelScale); x < (selectionOffset.x + selectionBox.right - 2) * pixelScale; x++) {
    const i = (y * beforeSelection.width + x) * 4;
    if ([0, 1, 2].every(c => beforeSelection.data[i + c] === 255)) shades.push([...afterSelection.data.subarray(i, i + 3)]);
  }
  const histogram = new Map(); for (const shade of shades) histogram.set(shade.join(','), (histogram.get(shade.join(',')) || 0) + 1);
  const uniform = [...histogram].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number), unevenPixels = shades.filter(shade => shade.some((value, c) => Math.abs(value - uniform[c]) > 3)).length;
  assert.ok(shades.length > 20 && Math.min(...uniform) < 230 && unevenPixels / shades.length < .02, `Selection shade varied on ${unevenPixels}/${shades.length} blank pixels: ${JSON.stringify([...histogram].sort((a, b) => b[1] - a[1]).slice(0, 8))}`);
  console.log('PASS: Libertine ligatures copy as plain text and selected text uses one uniform highlight layer.');
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } }); await add.waitFor({ state: 'hidden' });
  await selectPhrase('Our approach makes the writing process more better');
  const popup = frame.locator('#annotation-popover'); await popup.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.quick-input-widget:visible').count(), 0);
  const placement = await frame.evaluate(() => {
    const popup = document.querySelector('#annotation-popover').getBoundingClientRect(), selected = [...document.querySelectorAll('#paper .selection-box')].map(n => n.getBoundingClientRect());
    return { popup: popup.top, selection: Math.max(...selected.map(r => r.bottom)) };
  });
  assert.ok(placement.popup >= placement.selection, 'Opinion editor is not below selected text');
  await popup.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Rewrite this sentence concisely and fix the grammar.');
  await page.screenshot({ path: 'output/playwright/vscode-inline-note.png' });
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } }); await popup.waitFor({ state: 'hidden' });
  await until(async () => (await fs.readdir('output/host/paper/.pdf-local-copilot')).some(n => n.endsWith('.json')));
  const noteFile = 'output/host/paper/.pdf-local-copilot/' + (await fs.readdir('output/host/paper/.pdf-local-copilot')).find(n => n.endsWith('.json'));
  const historyDirectory = path.join(path.dirname(noteFile), 'history', path.basename(noteFile, '.json'));
  const historyPoints = async () => JSON.parse(await fs.readFile(path.join(historyDirectory, 'index.json'), 'utf8')).points;
  await until(async () => { try { return JSON.parse(await fs.readFile(noteFile, 'utf8')).notes.length === 1; } catch { return false; } });
  let notes = JSON.parse(await fs.readFile(noteFile, 'utf8')).notes, firstId = notes[0].id;
  assert.ok((await fs.readFile(path.join(path.dirname(main), notes[0].image))).subarray(1, 4).toString() === 'PNG');
  const chatFile = path.join(path.dirname(noteFile), 'conversations', path.basename(noteFile));
  const conversation = async () => JSON.parse(await fs.readFile(chatFile, 'utf8'));
  async function calls() { const c = await conversation(); if (!c.task) return []; try { return (await fs.readFile(path.join(path.dirname(main), '.pdf-local-copilot/test/fake-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } }
  assert.equal((await calls()).length, 0); assert.equal(await chat.locator('.queued-note').count(), 0);
  await frame.locator(`.note-marker[data-note-id="${firstId}"]`).click(); await popup.waitFor({ state: 'visible' });
  await popup.getByRole('button', { name: 'Edit', exact: true }).click(); await popup.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Rewrite this sentence concisely and fix the grammar.\nPreserve technical meaning.');
  await popup.getByRole('button', { name: 'Save', exact: true }).click(); await until(async () => (JSON.parse(await fs.readFile(noteFile, 'utf8')).notes[0].comment.includes('\nPreserve')));
  // Keep the opened comment anchored when scrolling, zooming, and typing unsaved TeX.
  const relativePopup = () => frame.evaluate(() => {
    const popup = document.querySelector('#annotation-popover').getBoundingClientRect(), marks = [...document.querySelectorAll('#paper .note-highlight')].map(n => n.getBoundingClientRect());
    return popup.top - Math.max(...marks.map(r => r.bottom));
  });
  const noteGap = await relativePopup();
  await frame.locator('#viewport').evaluate(v => { v.scrollTop += 80; });
  await until(async () => Math.abs(await relativePopup() - noteGap) < 1); assert.ok(await popup.isVisible());
  await command('Zoom In'); await until(async () => Math.abs(await relativePopup() - noteGap) < 1); assert.ok(await popup.isVisible());
  await command('Fit Width'); await until(async () => Math.abs(await relativePopup() - noteGap) < 1);
  await frame.evaluate(() => {
    window.liveAudit = { blank: 0, faded: 0, commits: 0 };
    const sample = () => { const image = document.querySelector('#paper .page-image'); if (!image?.complete || !image.naturalWidth) liveAudit.blank++; if (image && getComputedStyle(image).opacity !== '1') liveAudit.faded++; };
    window.liveObserver = new MutationObserver(() => { liveAudit.commits++; sample(); }); liveObserver.observe(document.querySelector('#paper'), { childList: true });
    window.liveSample = setInterval(sample, 10);
  });
  await sourceTab.click(); await page.keyboard.press('Control+g'); await input().fill(':16'); await page.keyboard.press('Enter'); await input().waitFor({ state: 'hidden' }); await page.keyboard.press('Meta+ArrowLeft');
  await page.keyboard.type('Live editing keeps annotations aligned. Live editing updates the preview. ', { delay: 25 });
  await until(async () => (await frame.locator('#paper .text-layer').textContent()).includes('Live editing keeps annotations aligned.') && !await frame.locator('#paper').evaluate(n => n.classList.contains('stale')));
  assert.equal(await fs.readFile(main, 'utf8'), original, 'Live editing unexpectedly saved the manuscript');
  assert.ok(await popup.isVisible()); assert.ok(Math.abs(await relativePopup() - noteGap) < 1);
  const followsText = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('#paper .text-layer span')], text = nodes.map(n => n.textContent).join(''), glyph = nodes[text.indexOf('Our approach')].getBoundingClientRect(), mark = document.querySelector('#paper .note-highlight').getBoundingClientRect();
    return Math.abs(mark.top - glyph.top) < 1;
  });
  assert.ok(followsText, 'Comment highlight lost the reflowed passage');
  const audit = await frame.evaluate(() => { clearInterval(liveSample); liveObserver.disconnect(); return liveAudit; });
  assert.ok(audit.commits > 0); assert.equal(audit.blank, 0, 'An undecoded page was shown while typing'); assert.equal(audit.faded, 0, 'The preview faded while typing');
  await page.screenshot({ path: 'output/playwright/vscode-live-annotation.png' });
  await page.getByRole('button', { name: 'Open Quick Access', exact: true }).click(); await input().fill('>File: Revert File'); await page.locator('.quick-input-widget:visible .monaco-list-row').filter({ hasText: 'File: Revert File' }).first().click();
  await until(async () => !(await frame.locator('#paper .text-layer').textContent()).includes('Live editing keeps annotations aligned.'));
  assert.ok(await popup.isVisible());
  await showPaper();
  await page.getByRole('treeitem').filter({ hasText: 'Rewrite this sentence concisely' }).first().getByRole('checkbox').click();
  await until(async () => await chat.locator('.queued-note').count() === 1);
  assert.equal((await calls()).length, 0, 'Selecting a note unexpectedly ran the agent');
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } });
  // Reflow, exact 5px page separation, wheel continuity, and source navigation after cropping.
  await fs.writeFile(main, original.replace('\\section{Introduction}', '\\newpage\n\\section{Introduction}'));
  await until(async () => JSON.parse(await fs.readFile(noteFile, 'utf8')).notes[0].page === 1);
  await frame.locator('.paper[data-page="1"] .page-image').waitFor({ state: 'attached' });
  await frame.evaluate(() => { document.querySelector('#viewport').scrollTop = 0; });
  const gap = await frame.evaluate(() => document.querySelector('.paper[data-page="1"]').getBoundingClientRect().top - document.querySelector('.paper[data-page="0"]').getBoundingClientRect().bottom);
  assert.ok(Math.abs(gap - 5) < 1, 'Page gap is not 5px: ' + gap);
  const wheel = await frame.evaluate(() => document.querySelector('#paper').getBoundingClientRect().bottom - document.querySelector('#viewport').getBoundingClientRect().top - document.querySelector('#viewport').clientHeight / 2);
  const view = await frame.locator('#viewport').boundingBox(); await page.mouse.move(view.x + 80, view.y + 100); await page.mouse.wheel(0, wheel);
  await frame.waitForFunction(() => { const v = document.querySelector('#viewport').getBoundingClientRect(), a = document.querySelector('#paper').getBoundingClientRect(), b = document.querySelector('#paper-2').getBoundingClientRect(); return a.bottom > v.top && a.bottom < v.bottom && b.top > v.top && b.top < v.bottom; });
  await page.screenshot({ path: 'output/playwright/vscode-cropped-continuous.png' });
  await frame.waitForFunction(() => { const paper = document.querySelector('#paper-2'); return paper && !paper.classList.contains('stale') && paper.querySelector('.text-layer')?.textContent.includes('Our approach'); });
  const index = await frame.evaluate(() => [...document.querySelectorAll('#paper-2 .text-layer span')].map(n => n.textContent).join('').indexOf('Our approach') + 5);
  await frame.locator('#paper-2 .text-layer span').nth(index).click({ modifiers: ['Control'] });
  await until(async () => { try { const jump = JSON.parse(await fs.readFile('output/host/source-jump.json', 'utf8')); return jump.line >= 18 && jump.line <= 23 && jump.text === 'approach'; } catch { return false; } });
  assert.equal(await page.getByRole('tab', { name: /^main\.tex(?:,|$)/ }).count(), 1, 'Source jump opened a duplicate TeX editor');
  const blank = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('#paper-2 .text-layer span')], text = nodes.map(n => n.textContent).join(''), first = nodes[text.indexOf('Our approach')].getBoundingClientRect();
    const line = nodes.filter(n => n.textContent.trim()).map(n => n.getBoundingClientRect()).filter(r => Math.abs((r.top + r.bottom - first.top - first.bottom) / 2) < 2);
    const paper = document.querySelector('#paper-2').getBoundingClientRect();
    return { x: Math.min(Math.max(...line.map(r => r.right)) + 2, paper.right - 1) - paper.left, y: (first.top + first.bottom) / 2 - paper.top };
  });
  await fs.rm('output/host/source-jump.json', { force: true });
  await frame.locator('#paper-2').click({ position: blank, modifiers: ['Control'] });
  await until(async () => { try { const jump = JSON.parse(await fs.readFile('output/host/source-jump.json', 'utf8')); return jump.line >= 18 && jump.line <= 23; } catch { return false; } });
  await frame.locator('#viewport').evaluate(v => { v.scrollTop = 0; });
  await sourceLine().click({ button: 'right' }); await page.getByRole('menuitem', { name: /PDF Local Copilot: Go to PDF Location/ }).click();
  await frame.locator('#paper-2 .source-location').waitFor();
  await frame.waitForFunction(() => { const mark = document.querySelector('#paper-2 .source-location').getBoundingClientRect(), view = document.querySelector('#viewport').getBoundingClientRect(); return mark.top >= view.top && mark.bottom <= view.bottom; });
  assert.equal(await page.getByRole('tab', { name: /^(?:Paper|Original) · main\.tex/ }).count(), 1, 'Forward sync opened a duplicate PDF');
  await page.getByRole('tab', { name: /^(?:Paper|Original) · main\.tex/ }).click(); if (await page.locator('.part.panel').isVisible()) await page.keyboard.press('Meta+j');
  await fs.writeFile(main, original); await until(async () => JSON.parse(await fs.readFile(noteFile, 'utf8')).notes[0].page === 0);
  await command('Go to Page'); await input().fill('1'); await page.keyboard.press('Enter');
  await frame.waitForFunction(() => document.querySelector('#paper .page-image') && !document.querySelector('#paper').classList.contains('stale'));
  // Another note enters the draft queue, not a separate context.
  await selectPhrase('The author can compare versions'); await popup.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Clarify this review instruction.');
  await popup.getByRole('button', { name: 'Save', exact: true }).click();
  await showPaper();
  await until(async () => JSON.parse(await fs.readFile(noteFile, 'utf8')).notes.length === 2);
  await command('Select All Annotations');
  await until(async () => await chat.locator('.queued-note').count() === 2); assert.equal((await calls()).length, 0);
  await showPaper();
  await page.getByRole('treeitem').filter({ hasText: 'Rewrite this sentence concisely' }).first().getByRole('checkbox').click();
  await until(async () => await chat.locator('.queued-note').count() === 1);
  await page.getByText('PDF Annotations', { exact: true }).hover();
  await page.getByRole('button', { name: 'PDF Local Copilot: Select All Annotations', exact: true }).click();
  await until(async () => await chat.locator('.queued-note').count() === 2); assert.equal((await calls()).length, 0, 'Selecting all annotations started the agent');
  await page.screenshot({ path: 'output/playwright/vscode-chat-task-draft.png' });
  const sessionId = (await conversation()).id;
  await chat.locator('#chat-model').selectOption('__custom__'); await page.getByText('Model Name', { exact: true }).waitFor(); await input().fill('test-model-a'); await page.keyboard.press('Enter');
  await until(async () => await chat.locator('#chat-model').inputValue() === 'test-model-a'); await chat.locator('#chat-effort').selectOption('high');
  await chat.locator('#chat-input').fill('Apply the queued PDF feedback.'); await chat.locator('#chat-input').press('Shift+Enter'); await chat.locator('#chat-input').pressSequentially('Keep citations accurate.');
  assert.ok((await chat.locator('#chat-input').inputValue()).includes('\n')); assert.equal((await calls()).length, 0);
  await chat.locator('#chat-input').evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assert.equal((await calls()).length, 0);
  await page.getByText('PDF Annotations', { exact: true }).hover();
  await page.getByRole('button', { name: 'PDF Local Copilot: Send Selected Annotations', exact: true }).click(); await page.keyboard.press('Meta+b');
  await until(async () => await chat.locator('.chat-message.user.running').count() >= 1);
  await until(async () => (await chat.locator('.chat-message.assistant.running .chat-message-text').textContent()).includes('Reading main.tex'));
  await chat.locator('.agent-activity summary').filter({ hasText: 'cat main.tex' }).first().click();
  await until(async () => (await chat.locator('.activity-output').first().textContent()).includes('documentclass'));
  await sourceTab.click(); await page.keyboard.press('Meta+ArrowUp');
  await page.screenshot({ path: 'output/playwright/vscode-live-agent-output.png' });
  await page.getByRole('tab', { name: /Paper Chat.*main\.tex/ }).click(); await page.keyboard.press('Meta+w');
  await command('Paper Chat and Task Queue'); await findChat();
  await until(async () => (await chat.locator('.chat-message.assistant.running .chat-message-text').textContent()).includes('Reading main.tex'));
  assert.equal((await conversation()).id, sessionId);
  // A second send while the first task is busy must remain in the same serial queue.
  await chat.locator('#chat-model').selectOption('__custom__'); await page.getByText('Model Name', { exact: true }).waitFor(); await input().fill('test-model-b'); await page.keyboard.press('Enter');
  await until(async () => await chat.locator('#chat-model').inputValue() === 'test-model-b'); await chat.locator('#chat-effort').selectOption('low');
  await chat.locator('#chat-input').fill('Keep the current edits and continue in this session.'); await chat.locator('#chat-input').press('Enter');
  await chat.locator('.queued-turn').waitFor({ timeout: 10000 });
  await chat.locator('#chat-effort').selectOption('high');
  await fs.writeFile(path.join(path.dirname(main), '.pdf-local-copilot/test/release-agent'), 'continue');
  await until(async () => (await calls()).length >= 2 && await chat.locator('#chat').getAttribute('aria-busy') === 'false', 90000);
  assert.equal(await frame.locator('.note-highlight,.note-marker').count(), 0, 'Processed PDF annotations remain visible by default');
  assert.equal((await historyPoints()).length, 0, 'Saving and agent completion created history without approval');
  let recorded = await calls(); assert.equal(recorded[0].resumed, false); assert.equal(recorded[1].resumed, true); assert.equal(recorded[0].cwd, recorded[1].cwd); assert.equal(recorded[0].args.filter(a => a === '--image').length, 2);
  assert.ok(recorded[0].prompt.includes('Keep citations accurate.'), 'Sidebar send lost the current chat draft');
  assert.equal(recorded[0].args[recorded[0].args.indexOf('--model') + 1], 'test-model-a'); assert.ok(recorded[0].args.includes('model_reasoning_effort="high"'));
  assert.equal(recorded[1].args[recorded[1].args.indexOf('--model') + 1], 'test-model-b'); assert.ok(recorded[1].args.includes('model_reasoning_effort="low"'));
  const previousRound = recorded[1].before; assert.ok(previousRound.includes('supports local revisions')); assert.notEqual(previousRound, original);
  assert.equal((await conversation()).id, sessionId); assert.ok((await fs.readFile(main, 'utf8')).includes('Our approach improves the efficiency of scientific writing.'));
  assert.equal(recorded[0].cwd, path.dirname(main));
  const liveTask = (await conversation()).task; assert.equal(liveTask.proposal, path.dirname(main)); assert.ok(liveTask.dir.startsWith(path.join(path.dirname(main), '.pdf-local-copilot/tasks')));
  await assert.rejects(fs.access(path.join(liveTask.baseline, 'unchanged.dat')));
  await until(async () => await frame.locator('#paper[data-side="before"] .review-marker').count() >= 2);
  assert.ok(await chat.locator('#new-session').isEnabled()); await chat.locator('#new-session').click();
  await chat.locator('#chat-error').filter({ hasText: 'pending review' }).waitFor(); assert.equal((await conversation()).id, sessionId);
  await showPaper();
  await sourceTab.click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Open Quick Access', exact: true }).click(); await input().fill('>View: Move Editor Group Right');
    await page.locator('.quick-input-widget:visible .monaco-list-row').filter({ hasText: 'Move Editor Group Right' }).first().click();
  }
  assert.ok(await sourceTab.evaluate(tab => !!(window.sourceEditorGroup = tab.closest('.editor-group-container'))), 'Source editor group was not found');
  assert.ok((await sourceTab.boundingBox()).x > (await page.getByRole('tab', { name: /Paper Chat.*main\.tex/ }).boundingBox()).x, 'Source group did not move to the right of chat');
  await chat.locator('#chat-input').fill('Keep this chat draft while browsing files.');
  await page.getByRole('tab', { name: /^Explorer(?:$| | -)/ }).click();
  await page.getByRole('treeitem', { name: /^unchanged\.dat/ }).dblclick();
  const explorerTab = page.getByRole('tab', { name: /^unchanged\.dat(?:,|$)/ });
  await until(async () => await explorerTab.evaluateAll(tabs => tabs.length === 1 && tabs[0].closest('.editor-group-container') === window.sourceEditorGroup));
  assert.equal(await chat.locator('#chat-input').inputValue(), 'Keep this chat draft while browsing files.');
  await chat.locator('#chat-input').click();
  await page.getByRole('tab', { name: /^Source Control(?:$| | -)/ }).click();
  await page.getByRole('treeitem').filter({ hasText: 'main.tex' }).last().click();
  const gitTab = page.getByRole('tab', { name: /main\.tex.*Working Tree/ });
  await until(async () => await gitTab.evaluateAll(tabs => tabs.length === 1 && tabs[0].closest('.editor-group-container') === window.sourceEditorGroup));
  assert.equal(await chat.locator('#chat-input').inputValue(), 'Keep this chat draft while browsing files.');
  assert.equal((await conversation()).id, sessionId);
  await page.screenshot({ path: 'output/playwright/vscode-git-diff-source-group.png' });
  await chat.locator('#chat-input').fill('');
  await showPaper();
  await chat.locator('#chat-input').click();
  await page.getByRole('treeitem').filter({ hasText: 'RevisedReferenceTitle' }).first().click();
  await page.getByRole('tab', { name: /Task changes · refs\.bib/ }).waitFor();
  assert.ok(await page.getByRole('tab', { name: /Task changes · refs\.bib/ }).evaluate(tab => tab.closest('.editor-group-container') === window.sourceEditorGroup), 'Bib diff replaced the chat editor group');
  await until(async () => { try { return JSON.parse(await fs.readFile('output/host/diff-selection.json', 'utf8')).text === 'RevisedReferenceTitle'; } catch { return false; } });
  await page.getByRole('treeitem').filter({ hasText: '2035' }).first().click();
  await until(async () => { try { const selected = JSON.parse(await fs.readFile('output/host/diff-selection.json', 'utf8')); return selected.text === '2035' && selected.line >= 10; } catch { return false; } });
  await page.screenshot({ path: 'output/playwright/vscode-bib-hunk-diff.png' });
  for (const [text, file] of [['newCodeValue', 'helper.js'], ['UpdatedPlanDescription', 'writingplan.md']]) {
    await (await reviewItem(text)).click();
    await until(async () => { try { const selected = JSON.parse(await fs.readFile('output/host/diff-selection.json', 'utf8')); return selected.file === file && selected.text === text; } catch { return false; } });
  }
  const texJumpStarted = Date.now();
  await (await reviewItem('improves the efficiency')).click();
  await page.getByRole('tab', { name: /Task changes · main\.tex/ }).waitFor();
  assert.ok(await page.getByRole('tab', { name: /Task changes · main\.tex/ }).evaluate(tab => tab.closest('.editor-group-container') === window.sourceEditorGroup), 'TeX diff ignored the existing source tab');
  await until(async () => { try { const selected = JSON.parse(await fs.readFile('output/host/diff-selection.json', 'utf8')); return selected.file === 'main.tex' && selected.text.includes('improves'); } catch { return false; } });
  const texJumpMs = Date.now() - texJumpStarted; assert.ok(texJumpMs < 1500, `Opening a TeX change waited ${texJumpMs} ms for PDF mapping`);
  console.log(`TeX jump to native diff: ${texJumpMs} ms`);
  await until(async () => await frame.locator('.review-mark.selected').count() > 0);
  const reviewBounds = await frame.evaluate(() => {
    const spans = [...document.querySelectorAll('#paper .text-layer span')], text = spans.map(span => span.textContent).join('');
    const marks = [...document.querySelectorAll('#paper .review-mark.selected')].map(mark => mark.getBoundingClientRect());
    return { start: spans[text.indexOf('improves')].getBoundingClientRect().left, markedStart: marks[0].left, end: spans[text.indexOf('writing.') + 6].getBoundingClientRect().right, markedEnd: marks.at(-1).right };
  });
  assert.ok(Math.abs(reviewBounds.start - reviewBounds.markedStart) < 1, 'Highlight starts on unrelated words before the edit');
  assert.ok(Math.abs(reviewBounds.end - reviewBounds.markedEnd) < 1, 'Highlight extends past the changed words');
  await page.screenshot({ path: 'output/playwright/vscode-tex-diff-current-pdf.png' });
  await page.keyboard.press('Meta+b'); await page.getByRole('tab', { name: /^Paper · main\.tex/ }).click();
  const pending = await frame.locator('.review-marker.pending').count();
  await frame.locator('.review-marker.pending[title*="main.tex"]').first().click(); await popup.getByRole('button', { name: 'Accept Change', exact: true }).waitFor();
  assert.ok((await popup.textContent()).includes('Keep the current edits and continue in this session.'));
  await frame.locator('#paper').click({ position: { x: 5, y: 8 } }); await popup.waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('.review-marker.pending').count(), pending, 'Dismissing review popup changed a decision');
  await chat.locator('#chat-input').fill('Keep my follow-up question.');
  await until(async () => (await conversation()).draft === 'Keep my follow-up question.');
  await frame.locator('.review-marker.pending[title*="main.tex"]').first().click(); await popup.getByRole('button', { name: 'Follow Up', exact: true }).click();
  await until(async () => { const value = await chat.locator('#chat-input').inputValue(); return value.includes('Keep the current edits and continue in this session.') && value.includes('Keep my follow-up question.'); });
  await until(async () => await chat.locator('#chat-input').evaluate(input => document.activeElement === input));
  assert.equal((await calls()).length, 2, 'Follow Up sent a task before the user submitted a question');
  assert.equal((await conversation()).id, sessionId); await chat.locator('#chat-input').fill('');
  await until(async () => (await conversation()).draft === '');
  await showPaper();
  await page.getByRole('treeitem').filter({ hasText: 'improves the efficiency' }).first().getByRole('checkbox').click();
  await until(async () => await page.getByRole('treeitem').filter({ hasText: 'improves the efficiency' }).first().getByRole('checkbox').getAttribute('aria-checked') === 'true');
  assert.equal(await frame.locator('.review-marker.pending').count(), pending, 'Selecting a checkbox accepted the change');
  assert.equal(JSON.parse(await fs.readFile(noteFile, 'utf8')).notes.find(note => note.id === firstId).status, 'reviewing');
  assert.equal((await historyPoints()).length, 0, 'Selecting a checkbox created a history checkpoint');
  await page.getByRole('button', { name: 'PDF Local Copilot: Accept Selected Changes', exact: true }).click();
  await until(async () => await page.getByRole('treeitem').filter({ hasText: 'improves the efficiency' }).count() === 0);
  await until(async () => (await historyPoints()).length === 1);
  assert.deepEqual((await historyPoints())[0].files.map(file => file.file), ['main.tex']);
  assert.ok(!(await historyPoints())[0].files[0].patch.includes('inspect proposed'), 'Approval history included an unaccepted edit');
  assert.equal(JSON.parse(await fs.readFile(noteFile, 'utf8')).notes.find(note => note.id === firstId).status, 'reviewing');
  assert.equal(await frame.locator(`.note-marker[data-note-id="${firstId}"]`).count(), 0);
  assert.equal(await frame.locator('.review-mark.accepted,.review-marker.accepted').count(), 0, 'Accepted PDF decorations were retained');
  assert.equal(await fs.readFile(path.join(liveTask.baseline, 'main.tex'), 'utf8'), previousRound, 'This round did not compare against the previous working draft');
  await until(async () => { try { const base = JSON.parse(await fs.readFile('output/host/diff-base.json', 'utf8')); return base.file === 'main.tex' && base.text.includes('improves the efficiency') && base.text.includes('The author can compare versions'); } catch { return false; } });
  await page.screenshot({ path: 'output/playwright/vscode-accepted-change-cleared.png' });
  await page.keyboard.press('Meta+b');
  await frame.locator('.review-marker.pending[title*="main.tex"]').last().click(); await popup.getByRole('button', { name: 'Reject Change', exact: true }).click();
  await until(async () => await frame.locator('.review-marker.rejected').count() === 1);
  await until(async () => (await frame.locator('#paper .text-layer').textContent()).replace(/\s+/g, ' ').includes('The author can compare versions'));
  assert.equal((await historyPoints()).length, 1, 'Rejecting an edit created an approval checkpoint');
  await showPaper();
  for (const [index, text] of ['RevisedReferenceTitle', '2035', 'newCodeValue', 'UpdatedPlanDescription'].entries()) {
    await (await reviewItem(text)).getByRole('checkbox').click();
    await until(async () => await page.getByRole('treeitem').filter({ hasText: text }).first().getByRole('checkbox').getAttribute('aria-checked') === 'true');
    await until(async () => (await conversation()).selectedEdits?.length === index + 1);
  }
  await page.getByRole('button', { name: 'PDF Local Copilot: Accept Selected Changes', exact: true }).click();
  for (const text of ['RevisedReferenceTitle', '2035', 'newCodeValue', 'UpdatedPlanDescription']) await until(async () => await page.getByRole('treeitem').filter({ hasText: text }).count() === 0);
  await until(async () => (await historyPoints()).length === 2);
  assert.equal((await historyPoints())[1].files.length, 3, 'A batch approval did not create one multi-file checkpoint');
  await until(async () => JSON.parse(await fs.readFile(path.join((await conversation()).task.dir, 'review.json'), 'utf8')).files.every(file => file.edits.every(edit => edit.decision !== 'pending')));
  await page.keyboard.press('Meta+b');
  await command('Finish Review');
  await until(async () => (await fs.readFile(main, 'utf8')).includes('Our approach improves the efficiency of scientific writing.'));
  await until(async () => (await conversation()).messages.some(m => m.role === 'system' && m.text.includes('Review complete;')));
  assert.equal((await conversation()).id, sessionId);
  let historyExpanded = false;
  async function openAgentHistory() {
    await showPaper();
    if (!historyExpanded) { await page.getByText('Local History', { exact: true }).click(); historyExpanded = true; }
    const point = await reviewItem('Accepted Changes · 1', 'Local History');
    await point.click(); await page.keyboard.press('ArrowRight');
    await (await reviewItem(/^main\.tex/, 'Local History')).click();
    await page.getByRole('tab', { name: /Local History.*main\.tex/ }).waitFor();
  }
  await openAgentHistory();
  await until(async () => { try { return JSON.parse(await fs.readFile('output/host/history-diff.json', 'utf8')).after.includes('improves the efficiency'); } catch { return false; } });
  const historyDiff = JSON.parse(await fs.readFile('output/host/history-diff.json', 'utf8'));
  assert.equal(historyDiff.readonly, true); assert.equal(historyDiff.before, original);
  assert.ok(!historyDiff.after.includes('inspect proposed')); assert.ok(!(await fs.readFile(main, 'utf8')).includes('inspect proposed'), 'Opening history replaced the current manuscript');
  assert.equal((await conversation()).id, sessionId);
  await page.screenshot({ path: 'output/playwright/vscode-local-history-readonly.png' });
  const git = require('node:child_process').execFileSync;
  git('git', ['add', 'main.tex', 'refs.bib', 'helper.js', 'writingplan.md'], { cwd: path.dirname(main) });
  git('git', ['-c', 'user.name=PDF Copilot Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Commit local revisions'], { cwd: path.dirname(main) });
  await until(async () => { try { return JSON.parse(await fs.readFile(path.join(historyDirectory, 'index.json'), 'utf8')).points.length === 0; } catch { return false; } });
  await until(async () => await page.getByRole('tab', { name: /Local History.*main\.tex/ }).count() === 0);
  assert.deepEqual(await fs.readdir(historyDirectory), ['index.json']);
  await page.screenshot({ path: 'output/playwright/vscode-local-history-cleared.png' });
  const beforeThird = await fs.readFile(main, 'utf8');
  assert.equal(await chat.locator('.queued-note').count(), 0, 'Direct conversation test unexpectedly attached annotations');
  await chat.locator('#chat-input').fill('Direct session change: improve the equation heading, keeping the same context.'); await chat.locator('#send-chat').click();
  await until(async () => (await calls()).length >= 3 && await chat.locator('#chat').getAttribute('aria-busy') === 'false', 90000);
  recorded = await calls(); assert.equal(recorded[2].resumed, true); assert.equal(recorded[2].cwd, recorded[0].cwd); assert.equal((await conversation()).id, sessionId);
  await until(async () => await frame.locator('.review-marker.pending[title*="From Conversation"]').count() >= 1);
  const sessionReview = JSON.parse(await fs.readFile(path.join((await conversation()).task.dir, 'review.json'), 'utf8'));
  const sessionEdit = sessionReview.files.flatMap(file => file.edits).find(edit => edit.inserted.includes('Improved'));
  assert.ok(sessionEdit); assert.equal(sessionEdit.origin, 'session'); assert.equal(sessionEdit.decision, 'pending');
  await until(async () => await frame.locator(`.review-mark[data-review-id="${sessionEdit.id}"]`).count() > 0);
  await showPaper(); await (await reviewItem('Improved')).click();
  await until(async () => { try { const selected = JSON.parse(await fs.readFile('output/host/diff-selection.json', 'utf8')); return selected.file === 'main.tex' && selected.text.includes('Improved'); } catch { return false; } });
  await until(async () => await frame.evaluate(id => {
    const spans = [...document.querySelectorAll('#paper .text-layer span')], text = spans.map(span => span.textContent).join(''), index = text.indexOf('Improved');
    if (index < 0) return false;
    const marks = [...document.querySelectorAll(`.review-mark[data-review-id="${id}"]`)].map(mark => mark.getBoundingClientRect());
    return spans.slice(index, index + 8).every(span => { const box = span.getBoundingClientRect(), x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2; return marks.some(mark => x >= mark.left - 1 && x <= mark.right + 1 && y >= mark.top - 1 && y <= mark.bottom + 1); });
  }, sessionEdit.id));
  console.log('PASS: chat without annotations creates a pending change in the sidebar, opens its exact native diff and highlights rendered PDF text with session origin.');
  await page.keyboard.press('Meta+b'); await page.getByRole('tab', { name: /^Paper · main\.tex/ }).click();
  await frame.locator('.review-marker.pending[title*="From Conversation"]').first().click();
  await popup.getByText('From Conversation', { exact: true }).waitFor(); assert.ok((await popup.textContent()).includes('Direct session change:'));
  await page.getByRole('tab', { name: /Paper Chat.*main\.tex/ }).click(); await page.keyboard.press('Meta+w');
  await until(async () => await page.getByRole('tab', { name: /Paper Chat.*main\.tex/ }).count() === 0);
  await frame.locator('.review-marker.pending[title*="From Conversation"]').first().click();
  await popup.getByRole('button', { name: 'Follow Up', exact: true }).click();
  await findChat();
  await until(async () => (await chat.locator('#chat-input').inputValue()).includes('Direct session change:'));
  await until(async () => await chat.locator('#chat-input').evaluate(input => document.activeElement === input));
  assert.equal((await calls()).length, 3); assert.equal((await conversation()).id, sessionId);
  assert.ok((await page.getByRole('tab', { name: /^main\.tex(?:,|$)/ }).last().boundingBox()).x > (await page.getByRole('tab', { name: /Paper Chat.*main\.tex/ }).boundingBox()).x, 'Reopening chat displaced the source editor group');
  await chat.locator('#chat-input').fill(''); await until(async () => (await conversation()).draft === '');
  await frame.locator('.review-marker.pending[title*="From Conversation"]').first().click();
  console.log('PASS: session-origin follow-up fills and focuses existing and recreated chat inputs, preserves drafts, and retains the CLI session.');
  await page.screenshot({ path: 'output/playwright/vscode-review-source-bubble.png' });
  await popup.getByRole('button', { name: 'Accept Change', exact: true }).click();
  await popup.waitFor({ state: 'hidden' });
  await until(async () => (await historyPoints()).length === 1);
  assert.equal((await historyPoints())[0].label, 'Accepted Change · main.tex');
  await page.screenshot({ path: 'output/playwright/vscode-chat-same-session.png' });
  await command('End Review'); await until(async () => await frame.locator('#paper').getAttribute('data-side') === 'before');
  await command('Undo Round'); await until(async () => await fs.readFile(main, 'utf8') === beforeThird);
  assert.equal((await historyPoints()).length, 1, 'Undo created a history checkpoint without approval');
  assert.equal((await conversation()).id, sessionId);
  await page.getByRole('tab', { name: /^Paper · main\.tex/ }).click();
  await selectPhrase('Our approach improves'); await popup.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Verify the current introduction.');
  await popup.getByRole('button', { name: 'Save', exact: true }).click();
  await popup.getByRole('button', { name: 'Send Task', exact: true }).click();
  await until(async () => (await calls()).length === 4 && await chat.locator('#chat').getAttribute('aria-busy') === 'false', 90000);
  assert.equal((await conversation()).id, sessionId);
  await selectPhrase('Our approach improves'); await popup.getByRole('textbox', { name: 'Annotation text', exact: true }).fill('Verify this paragraph.');
  await popup.getByRole('button', { name: 'Send Task', exact: true }).click();
  await until(async () => (await calls()).length === 5 && await chat.locator('#chat').getAttribute('aria-busy') === 'false', 90000);
  recorded = await calls(); assert.ok(recorded[3].resumed && recorded[4].resumed); assert.equal((await conversation()).id, sessionId);
  assert.equal((await historyPoints()).length, 1, 'Agent completion created a history checkpoint without approval');
  assert.equal(await chat.locator('.queued-note').count(), 0);
  await showPaper();
  await (await reviewItem('Accepted Change · main.tex', 'Local History')).click(); await page.keyboard.press('ArrowRight');
  await (await reviewItem(/^main\.tex/, 'Local History')).click();
  await page.getByRole('tab', { name: /Local History.*main\.tex/ }).waitFor();
  await chat.locator('#chat-messages').evaluate(messages => { messages.scrollTop = messages.scrollHeight; });
  assert.equal(await fs.readFile(main, 'utf8'), beforeThird, 'Historical diff changed the live manuscript');
  await page.screenshot({ path: 'output/playwright/vscode-local-history-readonly.png' });
  await page.keyboard.press('Meta+w');
  const commitBaseline = await fs.readFile(main, 'utf8'), planPath = path.join(path.dirname(main), 'writingplan.md'), planBaseline = await fs.readFile(planPath, 'utf8');
  const partialCommitText = commitBaseline.replace('improves the efficiency', 'improves the quality');
  const fullCommitText = partialCommitText.replace('The author can compare versions,', 'The author can compare revisions,');
  assert.notEqual(partialCommitText, commitBaseline); assert.notEqual(fullCommitText, partialCommitText);
  await fs.writeFile(main, fullCommitText); await fs.writeFile(planPath, planBaseline + '\nUncommitted review plan.\n');
  await command('Refresh Current Changes');
  const readCommitReview = async () => JSON.parse(await fs.readFile(path.join((await conversation()).task.dir, 'review.json'), 'utf8'));
  await until(async () => (await readCommitReview()).files.find(file => file.file === 'main.tex')?.edits.filter(edit => edit.decision === 'pending').length === 2);
  const committedEdit = (await readCommitReview()).files.find(file => file.file === 'main.tex').edits.find(edit => edit.inserted.includes('quality'));
  const commitBlob = git('git', ['hash-object', '-w', '--stdin'], { cwd: path.dirname(main), input: partialCommitText, encoding: 'utf8' }).trim();
  git('git', ['update-index', '--cacheinfo', `100644,${commitBlob},main.tex`], { cwd: path.dirname(main) });
  git('git', ['-c', 'user.name=PDF Copilot Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Approve one TeX change'], { cwd: path.dirname(main) });
  await until(async () => (await readCommitReview()).files.find(file => file.file === 'main.tex').edits.find(edit => edit.id === committedEdit.id)?.decision === 'accepted');
  assert.ok((await readCommitReview()).files.find(file => file.file === 'main.tex').edits.some(edit => edit.decision === 'pending'));
  assert.ok((await readCommitReview()).files.find(file => file.file === 'writingplan.md').edits.some(edit => edit.decision === 'pending'));
  await until(async () => await frame.locator(`.review-mark[data-review-id="${committedEdit.id}"]`).count() === 0);
  assert.equal(await fs.readFile(main, 'utf8'), fullCommitText, 'Git approval overwrote the uncommitted source edit');
  await command('Refresh Current Changes');
  assert.equal((await readCommitReview()).files.find(file => file.file === 'main.tex').edits.find(edit => edit.id === committedEdit.id)?.decision, 'accepted');
  git('git', ['add', 'main.tex'], { cwd: path.dirname(main) });
  git('git', ['-c', 'user.name=PDF Copilot Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Approve remaining TeX change'], { cwd: path.dirname(main) });
  await until(async () => (await readCommitReview()).files.find(file => file.file === 'main.tex').edits.every(edit => edit.decision === 'accepted'));
  assert.ok((await readCommitReview()).files.find(file => file.file === 'writingplan.md').edits.some(edit => edit.decision === 'pending'));
  await until(async () => { try { return (await historyPoints()).length === 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
  console.log('PASS: Git partial and whole-file commits accept only committed changes, remove PDF highlights, preserve unstaged files and reset approval history.');
  const endedRounds = (await conversation()).messages.filter(message => message.role === 'system' && message.text.startsWith('Review complete;')).length;
  await command('End Review');
  await until(async () => (await conversation()).messages.filter(message => message.role === 'system' && message.text.startsWith('Review complete;')).length > endedRounds);
  await fs.writeFile(main, commitBaseline); await fs.writeFile(planPath, planBaseline);
  await until(async () => await chat.locator('#new-session').isEnabled()); await chat.locator('#new-session').click();
  await until(async () => (await conversation()).id !== sessionId); assert.equal((await calls()).length, 0);
  await chat.locator('#chat-agent').selectOption('__add_claude__');
  await page.getByText('Add Claude Agent', { exact: true }).waitFor(); await input().fill('uclaude'); await page.keyboard.press('Enter');
  await page.getByText('Configure uclaude', { exact: true }).waitFor(); await input().fill('~/.claude-uni'); await page.keyboard.press('Enter');
  await until(async () => await chat.locator('#chat-agent').inputValue() === 'custom:uclaude');
  await chat.locator('#chat-model').selectOption('opus'); await chat.locator('#chat-effort').selectOption('xhigh');
  await until(async () => (await conversation()).runOptions?.model === 'opus' && (await conversation()).runOptions?.effort === 'xhigh');
  const userSettings = JSON.parse(await fs.readFile('output/host/profile/User/settings.json', 'utf8'));
  assert.equal(userSettings['pdfLocal.agents'][0].name, 'uclaude'); assert.equal(userSettings['pdfLocal.agents'][0].type, 'claude'); assert.equal(userSettings['pdfLocal.agents'][0].claude_config_dir, '~/.claude-uni');
  await page.screenshot({ path: 'output/playwright/vscode-custom-claude-agent.png' });
  await page.getByRole('tab', { name: /^Paper · main\.tex/ }).click();
  await command('Go to Page'); await input().fill('1'); await page.keyboard.press('Enter');
  async function referenceSpan(kind, number = '1') {
    const index = await frame.evaluate(({ kind, number }) => {
      const spans = [...document.querySelectorAll('#paper .text-layer span')], text = spans.map(span => span.textContent).join('');
      if (kind === 'Reference') { const group = /\[1,\s*2\]/.exec(text); return group ? group.index + group[0].indexOf(number) : -1; }
      const at = text.indexOf(kind), next = text.slice(at + kind.length).search(/\d/); return at < 0 || next < 0 ? -1 : at + kind.length + next;
    }, { kind, number });
    assert.ok(index >= 0, `No ${kind} link in the demo`); return frame.locator('#paper .text-layer span').nth(index);
  }
  const referenceCard = frame.locator('#reference-preview');
  for (const kind of ['Reference', 'Figure', 'Table']) {
    await frame.waitForFunction(() => !document.querySelector('#paper').classList.contains('stale'));
    let span = await referenceSpan(kind); await span.hover();
    const readingPosition = await frame.locator('#viewport').evaluate(view => view.scrollTop);
    await until(async () => { span = await referenceSpan(kind); await span.hover(); return await referenceCard.isVisible(); });
    await until(async () => (await referenceCard.locator('strong').textContent()).startsWith(kind) && await referenceCard.locator('img').count() === 1);
    assert.ok(Math.abs(await frame.locator('#viewport').evaluate(view => view.scrollTop) - readingPosition) < 1, 'Hover preview scrolled the reading position');
    const previewBox = await referenceCard.boundingBox();
    await page.mouse.move(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);
    await new Promise(resolve => setTimeout(resolve, 220)); assert.ok(await referenceCard.isVisible());
    await page.screenshot({ path: `output/playwright/reference-${kind.toLowerCase()}.png` });
    if (kind === 'Table') { await page.keyboard.press('Escape'); await referenceCard.waitFor({ state: 'hidden' }); await span.hover(); await referenceCard.waitFor({ state: 'visible' }); }
    await frame.locator('#paper').hover({ position: { x: 4, y: 4 } }); await referenceCard.waitFor({ state: 'hidden' });
  }
  await (await referenceSpan('Reference')).hover();
  await until(async () => (await referenceCard.locator('strong').textContent()) === 'Reference 1 · Page 3' && await referenceCard.locator('img').count() === 1);
  const firstCitationImage = await referenceCard.locator('img').getAttribute('src');
  const originalWidth = await referenceCard.locator('img').evaluate(image => image.getBoundingClientRect().width);
  const originalPixels = await referenceCard.locator('img').evaluate(image => image.naturalWidth);
  const originalSurface = await frame.locator('#paper .page-surface').evaluate(surface => surface.getBoundingClientRect().width);
  await (await referenceSpan('Reference', '2')).hover();
  await until(async () => (await referenceCard.locator('strong').textContent()) === 'Reference 2 · Page 3' && await referenceCard.locator('img').count() === 1 && await referenceCard.locator('img').getAttribute('src') !== firstCitationImage);
  for (let i = 0; i < 3; i++) await command('Zoom In');
  await (await referenceSpan('Reference')).hover();
  await until(async () => (await referenceCard.locator('strong').textContent()) === 'Reference 1 · Page 3' && await referenceCard.locator('img').count() === 1);
  const enlargedWidth = await referenceCard.locator('img').evaluate(image => image.getBoundingClientRect().width);
  const enlargedPixels = await referenceCard.locator('img').evaluate(image => image.naturalWidth);
  const enlargedSurface = await frame.locator('#paper .page-surface').evaluate(surface => surface.getBoundingClientRect().width);
  assert.ok(Math.abs(enlargedWidth / originalWidth - enlargedSurface / originalSurface) < .02, 'Preview was resized independently of the paper zoom');
  assert.ok(Math.abs(enlargedPixels / originalPixels - enlargedWidth / originalWidth) < .03, 'Zoom reused a low-resolution preview instead of rendering more pixels');
  assert.ok(await referenceCard.locator('img').evaluate(image => image.naturalWidth >= image.getBoundingClientRect().width * window.devicePixelRatio - 3), 'Preview has fewer pixels than the display requires');
  assert.ok(await referenceCard.locator('.reference-content').evaluate(content => content.scrollWidth > content.clientWidth), 'A wide preview was shrunk instead of retaining the paper scale');
  await command('Fit Width');
  await (await referenceSpan('Reference')).click();
  await frame.locator('.paper[data-page="2"] .page-image').waitFor();
  await until(async () => await frame.evaluate(() => {
    const spans = [...document.querySelectorAll('.paper[data-page="2"] .text-layer span')], text = spans.map(span => span.textContent).join(''), index = text.indexOf('Demo Author');
    if (index < 0) return false; const box = spans[index].getBoundingClientRect(), viewport = document.querySelector('#viewport').getBoundingClientRect(); return box.top >= viewport.top && box.bottom <= viewport.bottom;
  }));
  console.log('PASS: citation, figure and table hover cards show local rendered previews, retain reading position, stay open under the pointer, dismiss on leave, and link clicks navigate.');
  console.log('PASS: immutable local checkpoint diffs preserve the live manuscript; Git commit automatically clears history files and old diff tabs.');
  console.log('PASS: legacy proposal archived without overwriting manuscript; agent edits real workspace; sparse changed-file backups; TeX diff plus current-PDF highlight; Bib/JS/Markdown diffs; per-hunk rejection; review/whole-round undo; live output; resizable chat; session/model queue continuity.');
  await fs.writeFile('output/host/done', 'passed'); await browser.close();
})().catch(async e => { console.error(e); if (page) { console.error((await page.locator('body').innerText().catch(() => '')).slice(-7000)); await page.screenshot({ path: 'output/playwright/failure.png' }).catch(() => {}); } await browser?.close().catch(() => {}); process.exitCode = 1; });
