import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const log = await open('output/host-launch.log', 'w');
const host = spawn(process.execPath, ['scripts/test-host.mjs'], { env: { ...process.env, PDF_COPILOT_HOLD: '1' }, stdio: ['ignore', log.fd, log.fd] });
try {
  const deadline = Date.now() + 45000;
  while (true) {
    try { const r = await fetch('http://127.0.0.1:9339/json/list'); if (r.ok) break; } catch {}
    if (host.exitCode !== null || Date.now() > deadline) throw new Error('VS Code did not start. See output/host-launch.log.');
    await new Promise(r => setTimeout(r, 200));
  }
  await new Promise((resolve, reject) => {
    const check = spawn(process.execPath, ['scripts/check-ui.cjs'], { stdio: 'inherit' });
    check.once('exit', code => code === 0 ? resolve() : reject(new Error('UI check failed.')));
  });
  await new Promise((resolve, reject) => host.exitCode !== null ? (host.exitCode === 0 ? resolve() : reject(new Error('Host failed.'))) : host.once('exit', code => code === 0 ? resolve() : reject(new Error('Host failed.'))));
  await new Promise((resolve, reject) => {
    const check = spawn(process.execPath, ['scripts/check-restored.cjs'], { stdio: 'inherit' });
    check.once('exit', code => code === 0 ? resolve() : reject(new Error('Window restoration check failed.')));
  });
} catch (e) {
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9339');
    if ((await Promise.all(browser.contexts().flatMap(context => context.pages()).map(page => page.title()))).some(title => title.includes('Extension Development Host'))) await Promise.race([(await browser.newBrowserCDPSession()).send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    await browser.close();
  } catch {}
  host.kill(); throw e;
}
finally { await log.close(); }
