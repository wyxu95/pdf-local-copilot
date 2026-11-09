import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

export const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
const excludedDirs = new Set(['.git', 'node_modules', '.pdf-local-copilot', '.venv', 'venv', '.next', '_minted', '.cache']);
const generated = /\.(aux|log|bbl|blg|synctex(?:\.gz)?|xdv|dvi|fls|fdb_latexmk|toc|lof|lot|out|nav|snm|vrb|bcf|run\.xml)$/i;
export const reviewableFile = (file: string, main = '') => !generated.test(file) && (!main || file !== main.replace(/\.tex$/i, '.pdf')) && !file.split(/[\\/]/).some(part => excludedDirs.has(part));
async function gitFiles(root: string): Promise<Set<string> | undefined> {
  return new Promise(resolve => execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : new Set(stdout.split('\0').filter(Boolean)))));
}
export async function ignoredFiles(root: string, files: string[]): Promise<Set<string>> {
  if (!files.length) return new Set();
  return new Promise(resolve => {
    const child = execFile('git', ['check-ignore', '-z', '--stdin'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(!error || (error as any).code === 1 ? new Set(stdout.split('\0').filter(Boolean)) : new Set()));
    child.stdin?.end(files.join('\0') + '\0'); child.stdin?.on('error', () => {});
  });
}
export interface Change { file: string; kind: 'modified' | 'added' | 'deleted'; before?: Buffer; after?: Buffer }
export interface Task { id: string; dir: string; baseline: string; proposal: string; root: string; main: string; round?: number; sessions?: Partial<Record<string, string>>; mode?: 'workspace'; originalHashes?: Record<string, string>; externalChanges?: string[] }

export async function scan(root: string, main: string, respectGitIgnore = true) {
  const files = new Map<string, Buffer>();
  const listed = respectGitIgnore ? await gitFiles(root) : undefined;
  const directories = new Set<string>();
  for (const file of listed || []) for (let parent = path.dirname(file); parent !== '.' && parent !== path.dirname(parent); parent = path.dirname(parent)) directories.add(parent);
  let size = 0;
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (excludedDirs.has(entry.name) || entry.name.startsWith('_minted-') || entry.name === '.DS_Store') continue;
      const file = path.join(dir, entry.name), rel = path.relative(root, file);
      if (listed && (entry.isDirectory() ? !directories.has(rel) : !listed.has(rel))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Project contains a symbolic link: ${rel}. Use a project copy with regular files.`);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && reviewableFile(rel, main)) {
        const stat = await fs.stat(file);
        size += stat.size;
        if (size > 300 * 1024 * 1024) throw new Error('Project exceeds the 300 MiB task-copy limit. Open a smaller paper folder.');
        files.set(rel, await fs.readFile(file));
      }
    }
  };
  await walk(root);
  return files;
}

export async function createTask(root: string, main: string, storage: string): Promise<Task> {
  if (!inside(root, main)) throw new Error('The main TeX file must be inside the project folder.');
  const id = `${Date.now()}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
  const dir = path.join(storage, 'tasks', id), baseline = path.join(dir, 'baseline'), proposal = path.join(dir, 'proposal');
  const relativeMain = path.relative(root, main), files = await scan(root, relativeMain);
  for (const target of [baseline, proposal]) {
    await fs.mkdir(target, { recursive: true });
    for (const [file, bytes] of files) { const output = path.join(target, file); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, bytes); }
  }
  const task = { id, dir, baseline, proposal, root, main: relativeMain };
  await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
  return task;
}

export async function refreshTask(task: Task, storage: string): Promise<Task> {
  if (!inside(path.join(storage, 'tasks'), task.dir) || path.basename(task.dir) !== task.id || task.baseline !== path.join(task.dir, 'baseline') || task.proposal !== path.join(task.dir, 'proposal')) throw new Error('The task directory for this session is invalid.');
  const files = await scan(task.root, task.main), round = (task.round || 1) + 1;
  try {
    await fs.mkdir(path.join(task.dir, 'rounds'), { recursive: true }); await fs.copyFile(path.join(task.dir, 'review.json'), path.join(task.dir, 'rounds', `${round - 1}.json`));
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  for (const target of [task.baseline, task.proposal]) {
    await fs.rm(target, { recursive: true, force: true }); await fs.mkdir(target, { recursive: true });
    for (const [file, bytes] of files) { const output = path.join(target, file); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, bytes); }
  }
  await fs.unlink(path.join(task.dir, 'review.json')).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
  task.round = round; await fs.writeFile(path.join(task.dir, 'task.json'), JSON.stringify(task, null, 2)); return task;
}

export async function changes(task: Task): Promise<Change[]> {
  if (task.mode === 'workspace') {
    const current = await scan(task.root, task.main), hashes = task.originalHashes || {};
    const ignored = await ignoredFiles(task.root, Object.keys(hashes));
    const result: Change[] = [];
    for (const file of [...new Set([...Object.keys(hashes), ...current.keys()])].sort()) {
      if (!reviewableFile(file, task.main) || ignored.has(file)) continue;
      const hash = Object.hasOwn(hashes, file) ? hashes[file] : undefined;
      const after = current.get(file); if (hash === (after && digest(after))) continue;
      let before: Buffer | undefined;
      if (hash) {
        before = await fs.readFile(path.join(task.baseline, file));
        if (digest(before) !== hash) throw new Error(`Previous content checksum failed: ${file}`);
      }
      result.push({ file, before, after, kind: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified' });
    }
    return result;
  }
  const [before, after] = await Promise.all([scan(task.baseline, task.main, false), scan(task.proposal, task.main, false)]);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(file => {
    const a = before.get(file), b = after.get(file);
    return a && b && a.equals(b) ? [] : [{ file, kind: !a ? 'added' : !b ? 'deleted' : 'modified', before: a, after: b } as Change];
  });
}

export class WorkingTree {
  private writing: Promise<void> = Promise.resolve();
  private constructor(readonly task: Task, private originals: Map<string, Buffer>) {}
  original(file: string) { return this.originals.get(file); }
  static async create(root: string, main: string, sessions?: Task['sessions']) {
    if (!inside(root, main)) throw new Error('The main file must be inside the current project.');
    const files = await scan(root, path.relative(root, main)), id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(root, '.pdf-local-copilot', 'tasks', id), baseline = path.join(dir, 'before');
    const task: Task = { mode: 'workspace', id, dir, baseline, proposal: root, root, main: path.relative(root, main), sessions: { ...sessions }, originalHashes: Object.fromEntries([...files].map(([file, bytes]) => [file, digest(bytes)])) };
    await fs.mkdir(baseline, { recursive: true }); await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(task, null, 2));
    return new WorkingTree(task, files);
  }
  static async open(task: Task) {
    if (task.mode !== 'workspace' || task.proposal !== task.root || !inside(path.join(task.root, '.pdf-local-copilot', 'tasks'), task.dir) || task.baseline !== path.join(task.dir, 'before')) throw new Error('Invalid project task data.');
    const ignored = await ignoredFiles(task.root, Object.keys(task.originalHashes || {}));
    const excluded = Object.keys(task.originalHashes || {}).filter(file => !reviewableFile(file, task.main) || ignored.has(file));
    for (const file of excluded) delete task.originalHashes![file];
    const current = await scan(task.root, task.main), originals = new Map<string, Buffer>(), recorded = new Set<string>();
    try { const review = JSON.parse(await fs.readFile(path.join(task.dir, 'review.json'), 'utf8')); for (const file of review.files) if (file.beforeExists || file.before !== undefined) recorded.add(file.file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let rebased = !!excluded.length;
    for (const [file, hash] of Object.entries(task.originalHashes || {})) {
      const bytes = current.get(file);
      if (bytes && digest(bytes) === hash) originals.set(file, bytes);
      else {
        let old: Buffer;
        try { old = await fs.readFile(path.join(task.baseline, file)); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || recorded.has(file)) throw e;
          if (bytes) { originals.set(file, bytes); task.originalHashes![file] = digest(bytes); } else delete task.originalHashes![file];
          task.externalChanges = [...new Set([...(task.externalChanges || []), file])]; rebased = true; continue;
        }
        if (digest(old) !== hash) throw new Error(`Previous content checksum failed: ${file}`);
        originals.set(file, old);
      }
    }
    if (rebased) await fs.writeFile(path.join(task.dir, 'task.json'), JSON.stringify(task, null, 2));
    return new WorkingTree(task, originals);
  }
  capture() {
    this.writing = this.writing.catch(() => {}).then(async () => {
      const current = await scan(this.task.root, this.task.main);
      const ignored = await ignoredFiles(this.task.root, [...this.originals.keys()]);
      for (const [file, before] of this.originals) {
        if (!reviewableFile(file, this.task.main) || ignored.has(file)) continue;
        if (current.get(file)?.equals(before)) continue;
        const backup = path.join(this.task.baseline, file);
        try { await fs.access(backup); continue; } catch {}
        await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.writeFile(backup + '.tmp', before); await fs.rename(backup + '.tmp', backup);
      }
    });
    return this.writing;
  }
}

export async function applyChanges(task: Task, selected: string[]) {
  const available = (await changes(task)).filter(c => selected.includes(c.file));
  if (available.length !== new Set(selected).size) throw new Error('The selected change list is stale. Refresh the review.');
  return applyBatch(task.root, available);
}

export async function applyBatch(root: string, available: Change[]) {
  // Check the complete batch before writing any file. Also reject symlink parents.
  for (const c of available) {
    const target = path.join(root, c.file);
    if (!inside(root, target)) throw new Error('Change path is outside the project.');
    for (let p = target; p !== root; p = path.dirname(p)) {
      try { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error(`Symbolic link at ${p}.`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    let current: Buffer | undefined;
    try { current = await fs.readFile(target); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (c.before ? !current?.equals(c.before) : current !== undefined) throw new Error(`Source changed since this task started: ${c.file}. Review it manually before applying.`);
  }
  const written: Change[] = [];
  try {
    for (const c of available) {
      const target = path.join(root, c.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      written.push(c);
      if (c.after) { const temp = target + '.pdf-local-write'; await fs.writeFile(temp, c.after); await fs.rename(temp, target); } else await fs.unlink(target);
    }
  } catch (error) {
    for (const c of written.reverse()) { const target = path.join(root, c.file); if (c.before) await fs.writeFile(target, c.before); else await fs.unlink(target).catch(() => {}); }
    throw error;
  }
  return available.map(c => c.file);
}
