import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'linux-x64', 'linux-arm64'].includes(target)) throw new Error('Package on macOS ARM64 or Linux. Windows uses the Linux package in a WSL extension host.');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const native = JSON.parse(await readFile(path.join(root, 'native/build.json'), 'utf8'));
if (native.platform !== process.platform || native.arch !== process.arch) throw new Error('The native binaries belong to another platform. Run npm run native:build on this host first.');
execFileSync(path.join(root, 'node_modules/.bin/vsce'), ['package', '--target', target, '--no-dependencies', '--out', path.join(root, 'artifacts', `pdf-local-copilot-${manifest.version}-${target}.vsix`)], { cwd: root, stdio: 'inherit' });
