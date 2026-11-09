import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createPatch, applyPatch } from 'diff';
import { scan, digest, inside, reviewableFile, ignoredFiles } from './project';

export interface HistoryChange { file: string; beforeExists: boolean; afterExists: boolean; patch?: string; blob?: string }
export interface HistoryPoint { id: string; created: string; label: string; files: HistoryChange[] }
interface HistoryIndex { version: 1 | 2; head: string; prefix: string; points: HistoryPoint[] }
const directory = (root: string, main: string) => path.join(root, '.pdf-local-copilot', 'history', createHash('sha256').update(main).digest('hex').slice(0, 12));
const git = (root: string, args: string[]) => new Promise<Buffer>((resolve, reject) => execFile('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
async function scope(root: string) {
  try {
    const [repository, head] = (await git(root, ['rev-parse', '--show-toplevel', 'HEAD'])).toString().trim().split('\n');
    if (!/^[a-f0-9]{40,64}$/.test(head)) return;
    const prefix = path.relative(repository, await fs.realpath(root)).split(path.sep).join('/'); return { head, prefix: prefix ? prefix + '/' : '' };
  } catch { return; }
}
async function original(root: string, index: Pick<HistoryIndex, 'head' | 'prefix'>, file: string) {
  try { return await git(root, ['show', `${index.head}:${index.prefix}${file}`]); }
  catch (error) { if ((error as { code?: number }).code === 128) return undefined; throw error; }
}
const text = (bytes?: Buffer) => !bytes || !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes);
async function apply(root: string, main: string, change: HistoryChange, before?: Buffer) {
  if (!change.afterExists) return undefined;
  if (change.patch !== undefined) {
    const result = applyPatch(before?.toString('utf8') || '', change.patch);
    if (result === false) throw new Error(`Cannot reconstruct the local history patch: ${change.file}`);
    return Buffer.from(result);
  }
  if (!change.blob || !/^[a-f0-9]{64}$/.test(change.blob)) throw new Error('Invalid local history file.');
  const bytes = await fs.readFile(path.join(directory(root, main), 'blobs', change.blob));
  if (digest(bytes) !== change.blob) throw new Error(`Local history checksum failed: ${change.file}`);
  return bytes;
}
export async function readHistoryFile(root: string, main: string, head: string, point: string, side: 'before' | 'after', file: string) {
  if (!inside(root, path.resolve(root, file))) throw new Error('The historical file is outside this project.');
  const index: HistoryIndex = JSON.parse(await fs.readFile(path.join(directory(root, main), 'index.json'), 'utf8'));
  if (index.head !== head || (await scope(root))?.head !== head || !index.points.some(entry => entry.id === point && entry.files.some(change => change.file === file))) throw new Error('This record is outside the local history scope of the current commit.');
  let bytes = await original(root, index, file);
  for (const entry of index.points) {
    if (entry.id === point && side === 'before') return bytes || Buffer.alloc(0);
    const change = entry.files.find(change => change.file === file); if (change) bytes = await apply(root, main, change, bytes);
    if (entry.id === point) return bytes || Buffer.alloc(0);
  }
  throw new Error('Local history record not found.');
}

export class LocalHistory {
  head?: string;
  points: HistoryPoint[] = [];
  private index?: HistoryIndex;
  private snapshot = new Map<string, Buffer>();
  private writing: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, readonly main: string) {}
  refresh() {
    const next = this.writing.catch(() => {}).then(() => this.synchronize()); this.writing = next; return next;
  }
  approve(label: string, accepted: ReadonlyMap<string, Buffer | undefined>) {
    const next = this.writing.catch(() => {}).then(() => this.recordApproval(label, accepted)); this.writing = next; return next;
  }
  private async synchronize() {
    const currentScope = await scope(this.root);
    if (!currentScope) { this.head = undefined; this.points = []; this.index = undefined; return; }
    if (this.index && this.head === currentScope.head) return;
    const current = await scan(this.root, this.main);
    let saved: HistoryIndex | undefined;
    const store = directory(this.root, this.main), file = path.join(store, 'index.json');
    try { saved = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved && saved.head !== currentScope.head) { await fs.rm(store, { recursive: true, force: true }); saved = undefined; }
    if (saved?.version === 1) { await fs.writeFile(path.join(store, 'automatic-v1.json'), JSON.stringify(saved)); saved = undefined; }
    this.index = saved || { version: 2, ...currentScope, points: [] };
    this.head = currentScope.head; this.points = this.index.points;
    const changed = (await git(this.root, ['diff', '--name-only', '--no-renames', '--relative', '-z', this.head, '--', '.'])).toString().split('\0').filter(Boolean);
    const untracked = (await git(this.root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])).toString().split('\0').filter(Boolean);
    const touched = new Set([...changed, ...untracked, ...this.points.flatMap(point => point.files.map(change => change.file))]);
    this.snapshot = new Map(current);
    const ignored = await ignoredFiles(this.root, [...touched]);
    for (const file of touched) if (reviewableFile(file, this.main) && !ignored.has(file)) {
      const bytes = await original(this.root, this.index, file);
      if (bytes) this.snapshot.set(file, bytes); else this.snapshot.delete(file);
    }
    for (const point of this.points) for (const change of point.files) if (reviewableFile(change.file, this.main) && !ignored.has(change.file)) {
      const bytes = await apply(this.root, this.main, change, this.snapshot.get(change.file));
      if (bytes) this.snapshot.set(change.file, bytes); else this.snapshot.delete(change.file);
    }
    if (!saved) { await fs.mkdir(store, { recursive: true }); await fs.writeFile(file + '.tmp', JSON.stringify(this.index)); await fs.rename(file + '.tmp', file); }
  }
  private async recordApproval(label: string, accepted: ReadonlyMap<string, Buffer | undefined>) {
    await this.synchronize(); if (!this.index) return false;
    const current = new Map(this.snapshot);
    for (const [file, bytes] of accepted) if (bytes === undefined) current.delete(file); else current.set(file, bytes);
    const files: HistoryChange[] = [], names = [...new Set([...this.snapshot.keys(), ...current.keys()])], ignored = await ignoredFiles(this.root, names);
    for (const file of names) {
      if (!reviewableFile(file, this.main) || ignored.has(file)) continue;
      const before = this.snapshot.get(file), after = current.get(file);
      if (before === undefined && after === undefined || before && after && before.equals(after)) continue;
      const change: HistoryChange = { file, beforeExists: before !== undefined, afterExists: after !== undefined };
      if (text(before) && text(after)) change.patch = createPatch(file, before?.toString('utf8') || '', after?.toString('utf8') || '');
      else if (after) {
        change.blob = digest(after); const blob = path.join(directory(this.root, this.main), 'blobs', change.blob);
        await fs.mkdir(path.dirname(blob), { recursive: true }); await fs.writeFile(blob, after);
      }
      files.push(change);
    }
    if (files.length) this.points.push({ id: randomUUID(), created: new Date().toISOString(), label: label.replace(/\s+/g, ' ').trim().slice(0, 100), files });
    const file = path.join(directory(this.root, this.main), 'index.json');
    try {
      if (files.length) {
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file + '.tmp', JSON.stringify(this.index)); await fs.rename(file + '.tmp', file);
      }
    } catch (error) { if (files.length) this.points.pop(); throw error; }
    this.snapshot = current;
    return files.length > 0;
  }
}
