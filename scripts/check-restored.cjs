const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
let browser, page;
const until = async fn => { const deadline = Date.now() + 60000; while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error('Timed out restoring windows'); };
(async () => {
  const root = process.cwd(), profile = path.join(root, 'output/host/profile');
  const metadata = path.join(root, 'output/host/paper/.pdf-local-copilot/conversations');
  const conversationFile = path.join(metadata, (await fs.readdir(metadata)).find(name => name.endsWith('.json')));
  const session = JSON.parse(await fs.readFile(conversationFile, 'utf8')).id;
  const noteRoot = path.dirname(metadata), noteFile = path.join(noteRoot, (await fs.readdir(noteRoot)).find(name => name.endsWith('.json')));
  const saved = JSON.parse(await fs.readFile(noteFile, 'utf8'));
  saved.notes = saved.notes.filter(note => !['reload-macro', 'reload-removed'].includes(note.id));
  for (const [id, quote, number] of [['reload-macro', 'The author can compare versions,', 100], ['reload-removed', 'Removed hypothesis with no remaining PDF text.', 101]]) saved.notes.push({ id, number, page: 0, rects: [[10, 20, 100, 30]], quote, comment: 'Reload annotation regression', source: { file: 'main.tex', line: 1, text: '\\documentclass' }, anchorStatus: 'anchored' });
  await fs.writeFile(noteFile, JSON.stringify(saved));
  const args = [path.join(root, 'output/host/paper'), '--user-data-dir=' + profile, '--extensions-dir=' + path.join(root, 'output/host/extensions'), '--remote-debugging-port=9341', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'];
  args.push('--extensionDevelopmentPath=' + (process.env.PDF_COPILOT_VSIX ? path.join(root, 'output/host/driver') : root));
  spawn('/Applications/Visual Studio Code.app/Contents/MacOS/Code', args, { stdio: 'ignore' });
  await until(async () => { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9341'); return true; } catch { return false; } });
  await until(async () => { page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench')); return !!page; });
  await page.getByRole('treeitem', { name: /^main\.tex/ }).dblclick();
  await page.getByRole('button', { name: 'PDF Local Copilot: Open Paper', exact: true }).click();
  const check = async () => {
    let pdf, chat;
    await until(async () => { for (const frame of page.frames()) { if (await frame.locator('#paper .page-image').count().catch(() => 0)) pdf = frame; if (await frame.locator('body.chat-only #chat-agent').count().catch(() => 0)) chat = frame; } return !!pdf && !!chat; });
    await until(async () => await chat.locator('#chat-agent').inputValue() === 'custom:uclaude');
    assert.equal(await chat.locator('#chat-model').inputValue(), 'opus');
    assert.equal(JSON.parse(await fs.readFile(conversationFile, 'utf8')).id, session);
    assert.equal(await page.getByRole('tab', { name: /^Paper · main\.tex/ }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: /Paper Chat.*main\.tex/ }).count(), 1);
    await until(async () => {
      const notes = JSON.parse(await fs.readFile(noteFile, 'utf8')).notes;
      return notes.find(note => note.id === 'reload-macro').rects[0][1] > 100 && notes.find(note => note.id === 'reload-removed').anchorStatus === 'orphaned';
    });
    assert.equal(await pdf.locator('.note-marker[data-note-id="reload-macro"]').count(), 1);
    assert.equal(await pdf.locator('.note-marker[data-note-id="reload-removed"]').count(), 0);
  };
  await check();
  await page.getByRole('button', { name: 'Open Quick Access', exact: true }).click();
  await page.locator('.quick-input-widget input').fill('>Developer: Reload Window');
  await page.locator('.quick-input-widget:visible .monaco-list-row').filter({ hasText: 'Developer: Reload Window' }).first().click();
  await new Promise(resolve => setTimeout(resolve, 2000)); await check();
  await Promise.race([(await browser.newBrowserCDPSession()).send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); await browser.close();
  await new Promise(resolve => setTimeout(resolve, 1500));
  spawn('/Applications/Visual Studio Code.app/Contents/MacOS/Code', args.map(arg => arg.replace('--remote-debugging-port=9341', '--remote-debugging-port=9342')), { stdio: 'ignore' });
  await until(async () => { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9342'); return true; } catch { return false; } });
  await until(async () => { page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench')); return !!page; });
  await check();
  await page.screenshot({ path: 'output/playwright/vscode-restored-panels.png' });
  console.log('PASS: normal VS Code restart and window reload restore PDF and chat once, preserving the session, agent and model.');
})().catch(async error => { console.error(error); if (page) { console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000)); await page.screenshot({ path: 'output/playwright/restore-failure.png' }).catch(() => {}); } process.exitCode = 1; }).finally(async () => {
  if (browser) { await Promise.race([(await browser.newBrowserCDPSession()).send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); await browser.close().catch(() => {}); }
});
