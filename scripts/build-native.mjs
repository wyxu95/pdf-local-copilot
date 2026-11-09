import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, copyFile, writeFile, access, chmod, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'vendor/texpresso');
const revision = 'df8b0941ef19b36377014d18a9a264f3591280b1';
const run = (cmd, args, cwd = source) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
await mkdir(path.dirname(source), { recursive: true });
try { await access(path.join(source, '.git')); }
catch { run('git', ['clone', 'https://github.com/DominikPeters/texpresso.git', source], root); }
const current = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (current !== revision) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' });
  if (dirty.trim()) throw new Error('Native source has local changes at another revision. Preserve them before building.');
  run('git', ['fetch', 'https://github.com/DominikPeters/texpresso.git', revision]); run('git', ['checkout', '--detach', revision]);
}
for (const name of ['texpresso-text-layer.patch', 'texpresso-pdf-links.patch']) {
  const patch = path.join(root, 'scripts', name);
  const check = spawnSync('git', ['apply', '--check', patch], { cwd: source, encoding: 'utf8' });
  if (check.status === 0) run('git', ['apply', patch]);
  else {
    const applied = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: source, encoding: 'utf8' });
    if (applied.status !== 0) throw new Error(`Native patch ${name} does not match the checkout. Preserve local edits before rebuilding.\n${check.stderr}`);
  }
}
const args = ['-j8', 'all'];
if (process.platform === 'darwin') {
  for (const prefix of ['/opt/homebrew/opt/icu4c@78', '/usr/local/opt/icu4c@78', '/opt/homebrew/opt/icu4c', '/usr/local/opt/icu4c']) {
    try { await access(path.join(prefix, 'include/unicode/ubidi.h')); args.push(`BREW_ICU4C=${prefix}`); break; } catch {}
  }
}
run('make', args);
const native = path.join(root, 'native'); await mkdir(native, { recursive: true });
for (const binary of ['texpresso', 'texpresso-xetex']) {
  const temporary = path.join(native, `${binary}.new-${process.pid}`);
  await copyFile(path.join(source, 'build', binary), temporary); await chmod(temporary, 0o755); await rename(temporary, path.join(native, binary));
}
await copyFile(path.join(source, 'LICENSE'), path.join(native, 'TEXPRESSO-LICENSE'));
const capabilities = execFileSync(path.join(native, 'texpresso'), ['-capabilities'], { encoding: 'utf8' });
await writeFile(path.join(native, 'build.json'), JSON.stringify({ platform: process.platform, arch: process.arch, revision, textLayerPatch: true, pdfLinksPatch: true, capabilities: JSON.parse(capabilities), note: 'Built against this host’s installed native libraries. Rebuild on a different host.' }, null, 2));
console.log(`Native build ready: ${native}`);
