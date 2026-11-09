import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyBatch, digest, inside, reviewableFile, ignoredFiles, type Change, type Task } from './project';
export interface Application {
  id: string; root: string; state: 'prepared' | 'applied' | 'undone' | 'failed'; created: string;
  mode?: 'workspace';
  files: { file: string; before?: string; after?: string; beforeRef?: string; beforeHash?: string; afterHash?: string }[];
}
export async function applyWithUndo(root: string, plan: Change[], storage: string) {
  const record: Application = { id: randomUUID(), root, state: 'prepared', created: new Date().toISOString(), files: plan.map(c => ({ file: c.file, before: c.before?.toString('base64'), after: c.after?.toString('base64') })) };
  const file = path.join(storage, 'applications', record.id + '.json'); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record));
  try { await applyBatch(root, plan); record.state = 'applied'; }
  catch (e) { record.state = 'failed'; await fs.writeFile(file, JSON.stringify(record)); throw e; }
  await fs.writeFile(file, JSON.stringify(record)); return file;
}
export async function recordWorkspace(task: Task, plan: Change[]) {
  const record: Application = { id: randomUUID(), root: task.root, mode: 'workspace', state: 'applied', created: new Date().toISOString(), files: plan.map(change => ({ file: change.file, beforeRef: change.before === undefined ? undefined : path.relative(task.root, path.join(task.baseline, change.file)), beforeHash: change.before === undefined ? undefined : digest(change.before), afterHash: change.after === undefined ? undefined : digest(change.after) })) };
  const file = path.join(task.root, '.pdf-local-copilot', 'applications', record.id + '.json');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(record)); return file;
}
export async function undoApplication(file: string, root: string) {
  const record: Application = JSON.parse(await fs.readFile(file, 'utf8'));
  if (record.root !== root || record.state !== 'applied') throw new Error('This operation has been undone or belongs to another paper.');
  const plan: Change[] = [];
  const ignored = await ignoredFiles(root, record.files.map(file => file.file));
  for (const entry of record.files) {
    if (!reviewableFile(entry.file) || ignored.has(entry.file)) continue;
    if (record.mode !== 'workspace') { plan.push({ file: entry.file, before: entry.after === undefined ? undefined : Buffer.from(entry.after, 'base64'), after: entry.before === undefined ? undefined : Buffer.from(entry.before, 'base64'), kind: entry.before === undefined ? 'deleted' : entry.after === undefined ? 'added' : 'modified' }); continue; }
    let current: Buffer | undefined, old: Buffer | undefined;
    try { current = await fs.readFile(path.join(root, entry.file)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (entry.afterHash === undefined ? current !== undefined : !current || digest(current) !== entry.afterHash) throw new Error(`Source changed since review: ${entry.file}`);
    if (entry.beforeRef) {
      const backup = path.resolve(root, entry.beforeRef); if (!inside(path.join(root, '.pdf-local-copilot'), backup)) throw new Error('The previous-content path in the undo record is invalid.');
      old = await fs.readFile(backup); if (digest(old) !== entry.beforeHash) throw new Error(`Previous content checksum failed: ${entry.file}`);
    }
    plan.push({ file: entry.file, before: current, after: old, kind: old === undefined ? 'deleted' : current === undefined ? 'added' : 'modified' });
  }
  await applyBatch(root, plan); record.state = 'undone'; await fs.writeFile(file, JSON.stringify(record)); return plan.map(c => c.file);
}
