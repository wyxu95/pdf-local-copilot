import { execFileSync } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('Run this installer on the Mac hosting the project.');
if (!process.argv[2]) throw new Error('Usage: npm run install:mac -- /path/to/pdf-local-copilot-darwin-arm64.vsix');
const archive = path.resolve(process.argv[2]);
const manifest = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', archive, 'extension/package.json'], { encoding: 'utf8' }));
if (manifest.publisher !== 'local-paper-tools' || manifest.name !== 'pdf-local-copilot') throw new Error('Choose a PDF Local Copilot VSIX.');
const targets = ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'];
const directory = path.join(homedir(), '.vscode-server', 'cli', 'servers');
const servers = [];
try {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cli = path.join(directory, entry.name, 'server', 'bin', 'code-server');
    try { servers.push({ cli, modified: (await stat(cli)).mtimeMs }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
servers.sort((a, b) => b.modified - a.modified);
if (servers.length) targets.push(servers[0].cli);
const expected = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
const environment = { ...process.env };
// The desktop CLI otherwise redirects to the remote CLI inside an SSH terminal.
delete environment.VSCODE_IPC_HOOK_CLI;
for (const cli of targets) {
  await access(cli);
  execFileSync(cli, ['--install-extension', archive, '--force'], { stdio: 'inherit', env: environment });
  const installed = execFileSync(cli, ['--list-extensions', '--show-versions'], { encoding: 'utf8', env: environment });
  if (!installed.split(/\r?\n/).includes(expected)) throw new Error(`Version verification failed for ${cli}`);
}
console.log(`Verified ${expected} in ${targets.length} extension stores. Reload the Mac and Remote SSH windows to activate it.`);
