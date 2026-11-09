import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { launch, terminate } from './process';
import { inside } from './project';
export type TexEngine = 'xelatex' | 'pdflatex' | 'lualatex';
export interface BuildStep { command: string; args: string[] }
export interface BuildResult { pdf: string; output: string; engine: TexEngine; directory: string }
export interface BuildProblem { file: string; line: number; message: string }

export async function mainCandidates(root: string) {
  const result: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.pdf-local-copilot', '.venv'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.tex') && /\\(?:documentclass|begin\s*\{document\})/.test(await fs.readFile(file, 'utf8'))) result.push(file);
    }
  };
  await walk(root); return result.sort();
}
export async function resolveMain(file: string, root: string): Promise<string[]> {
  const visited = new Set<string>();
  let current = file;
  if (current.toLowerCase().endsWith('.pdf')) {
    const sibling = current.replace(/\.pdf$/i, '.tex');
    try { await fs.access(sibling); current = sibling; } catch { return mainCandidates(root); }
  }
  while (true) {
    if (!inside(root, current)) throw new Error('The main file is outside the current project.');
    if (visited.has(current)) throw new Error('The TeX root directives form a cycle. Correct the main-file path.');
    visited.add(current); const text = await fs.readFile(current, 'utf8');
    const magic = text.match(/^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im);
    if (magic) { current = path.resolve(path.dirname(current), magic[1].replace(/^['"]|['"]$/g, '')); continue; }
    if (/\\(?:documentclass|begin\s*\{document\})/.test(text)) return [current];
    return mainCandidates(root);
  }
}
export async function engineFor(main: string): Promise<TexEngine> {
  const text = await fs.readFile(main, 'utf8'), magic = text.match(/^\s*%\s*!\s*TeX\s+(?:program|TS-program)\s*=\s*(\S+)/im)?.[1]?.toLowerCase();
  if (magic && !['xelatex', 'pdflatex', 'lualatex'].includes(magic)) throw new Error(`Unsupported TeX engine ${magic}. Choose XeLaTeX, pdfLaTeX, or LuaLaTeX.`);
  return (magic as TexEngine) || 'xelatex';
}
export function parseProblems(output: string, cwd: string): BuildProblem[] {
  return output.split(/\r?\n/).flatMap(line => { const m = line.match(/^(.+?\.tex):(\d+):\s*(.+)/); return m ? [{ file: path.resolve(cwd, m[1]), line: Number(m[2]), message: m[3] }] : []; });
}
export class BuildManager {
  readonly directory: string; readonly stableDirectory: string; readonly pdf: string;
  private tail: Promise<unknown> = Promise.resolve(); private child?: ReturnType<typeof launch>; private closed = false;
  constructor(readonly root: string, readonly main: string, readonly engine: TexEngine, private log: (text: string) => void, private steps: BuildStep[] = []) {
    const id = createHash('sha256').update(path.relative(root, main)).digest('hex').slice(0, 12);
    this.directory = path.join(root, '.pdf-local-copilot', 'build', id, 'work'); this.stableDirectory = path.join(root, '.pdf-local-copilot', 'build', id, 'stable'); this.pdf = path.join(this.stableDirectory, path.basename(main, '.tex') + '.pdf');
  }
  private command(binary: string, args: string[], cwd: string) {
    return new Promise<string>((resolve, reject) => {
      const child = launch(binary, args, cwd); this.child = child; child.stdin.end(); let output = '';
      const accept = (s: Buffer) => { const text = s.toString('utf8'); output = (output + text).slice(-2 * 1024 * 1024); this.log(text); };
      child.stdout.on('data', accept); child.stderr.on('data', accept); child.once('error', reject);
      const timer = setTimeout(() => { void terminate(child); }, 180000);
      child.once('close', code => { clearTimeout(timer); this.child = undefined; code === 0 ? resolve(output) : reject(Object.assign(new Error(`${binary} build failed (${code}). See Output for details.`), { output })); });
    });
  }
  build(): Promise<BuildResult> {
    const run = this.tail.catch(() => {}).then(async () => {
      if (this.closed) throw new Error('Build cancelled.');
      await fs.mkdir(this.directory, { recursive: true }); await fs.mkdir(this.stableDirectory, { recursive: true });
      for (const step of this.steps) { if (!step.command || !Array.isArray(step.args) || !step.args.every(a => typeof a === 'string')) throw new Error('Each build step requires a command and an args array.'); await this.command(step.command, step.args, this.root); }
      const flag = { xelatex: '-pdfxe', pdflatex: '-pdf', lualatex: '-pdflua' }[this.engine];
      const output = await this.command('latexmk', [flag, '-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', `-outdir=${this.directory}`, path.basename(this.main)], path.dirname(this.main));
      const base = path.basename(this.main, '.tex');
      for (const suffix of ['.pdf', '.synctex.gz']) {
        const source = path.join(this.directory, base + suffix), target = path.join(this.stableDirectory, base + suffix);
        await fs.copyFile(source, target + '.tmp'); await fs.rename(target + '.tmp', target);
      }
      return { pdf: this.pdf, directory: this.directory, engine: this.engine, output };
    });
    this.tail = run; return run;
  }
  async stop() { this.closed = true; if (this.child) await terminate(this.child); }
}
