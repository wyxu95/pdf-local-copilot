import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, cp, chmod, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await rm(path.join(root, 'output/host'), { recursive: true, force: true });
await mkdir(path.join(root, 'output/host'), { recursive: true });
await cp(path.join(root, 'examples/paper'), path.join(root, 'output/host/paper'), { recursive: true });
const testMain = path.join(root, 'output/host/paper/main.tex');
await writeFile(testMain, (await readFile(testMain, 'utf8')).replace('\\author{Local Copilot Demo}', '\\author{ANONYMOUS AUTHOR(S)}'));
await writeFile(path.join(root, 'output/host/paper/refs.bib'), '@article{testA,\n  title = {OldReferenceTitle},\n  author = {Alice},\n  year = {2020},\n  note = {A long unchanged reference note separates this entry from the next one.}\n}\n\n@article{testB,\n  title = {Another reference},\n  author = {Bob},\n  year = {2021}\n}\n');
await writeFile(path.join(root, 'output/host/paper/unchanged.dat'), 'Unchanged project asset');
await writeFile(path.join(root, 'output/host/paper/helper.js'), 'export const result = "oldCodeValue";\n');
await writeFile(path.join(root, 'output/host/paper/writingplan.md'), '# Plan\n\nOldPlanDescription\n');
execFileSync('/Library/TeX/texbin/latexmk', ['-pdfxe', '-synctex=1', '-interaction=nonstopmode', 'main.tex'], { cwd: path.join(root, 'output/host/paper'), stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
const paperRoot = path.join(root, 'output/host/paper'), legacyDir = path.join(root, 'output/host/profile/User/globalStorage/local-paper-tools.pdf-local-copilot/tasks/legacy-review');
await cp(paperRoot, path.join(legacyDir, 'baseline'), { recursive: true }); await cp(paperRoot, path.join(legacyDir, 'proposal'), { recursive: true });
await writeFile(path.join(legacyDir, 'proposal/main.tex'), 'Unapplied legacy proposal to archive.');
const legacy = { id: 'legacy-review', dir: legacyDir, root: paperRoot, main: 'main.tex', baseline: path.join(legacyDir, 'baseline'), proposal: path.join(legacyDir, 'proposal'), sessions: {} };
await writeFile(path.join(legacyDir, 'task.json'), JSON.stringify(legacy));
const conversation = path.join(paperRoot, '.pdf-local-copilot/conversations', createHash('sha256').update('main.tex').digest('hex').slice(0, 12) + '.json');
await mkdir(path.dirname(conversation), { recursive: true }); await writeFile(conversation, JSON.stringify({ version: 1, id: '11111111-1111-4111-8111-222222222222', agent: 'codex', messages: [], queue: [], paused: false, draft: '', selectedNotes: [], contextUpdates: [], task: legacy }));
await writeFile(path.join(paperRoot, '.gitignore'), '.pdf-local-copilot/\n*.aux\n*.fdb_latexmk\n*.fls\n*.log\n*.out\n*.pdf\n*.synctex.gz\n*.xdv\n');
execFileSync('git', ['init', '-q'], { cwd: paperRoot });
execFileSync('git', ['add', '.gitignore', 'main.tex', 'refs.bib', 'helper.js', 'writingplan.md', 'unchanged.dat'], { cwd: paperRoot });
execFileSync('git', ['-c', 'user.name=PDF Copilot Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture baseline'], { cwd: paperRoot });
await cp(path.join(root, 'test/fake-codex.cjs'), path.join(root, 'output/host/fake-codex'));
await chmod(path.join(root, 'output/host/fake-codex'), 0o755);
await build({ entryPoints: [path.join(root, 'test/host-suite.ts')], outfile: path.join(root, 'output/host/suite.cjs'), bundle: true, platform: 'node', external: ['vscode'], format: 'cjs' });
const args = [path.join(root, 'output/host/paper'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--remote-debugging-port=9339', '--user-data-dir=' + path.join(root, 'output/host/profile'), '--extensions-dir=' + path.join(root, 'output/host/extensions')];
if (process.env.PDF_COPILOT_VSIX) {
  execFileSync('/usr/local/bin/code', ['--install-extension', path.resolve(process.env.PDF_COPILOT_VSIX), '--extensions-dir', path.join(root, 'output/host/extensions'), '--user-data-dir', path.join(root, 'output/host/profile')], { stdio: 'inherit' });
  await mkdir(path.join(root, 'output/host/driver'), { recursive: true });
  await writeFile(path.join(root, 'output/host/driver/package.json'), JSON.stringify({ name: 'pdf-local-test-driver', publisher: 'test', version: '0.0.1', engines: { vscode: '^1.96.0' }, main: './extension.js' }));
  await writeFile(path.join(root, 'output/host/driver/extension.js'), 'exports.activate = () => {};');
}
await runTests({
  vscodeExecutablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: process.env.PDF_COPILOT_VSIX ? path.join(root, 'output/host/driver') : root,
  extensionTestsPath: path.join(root, 'output/host/suite.cjs'),
  launchArgs: args,
  extensionTestsEnv: { PDF_COPILOT_ROOT: root, PDF_COPILOT_HOLD: process.env.PDF_COPILOT_HOLD || '' }
});
