import { diffWordsWithSpace, diffLines } from 'diff';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, reviewableFile, ignoredFiles, type Change, type Task } from './project';
import type { Note } from './agent';

export type Decision = 'pending' | 'accepted' | 'rejected';
export interface Edit {
  id: string; file: string; start: number; end: number; inserted: string; removed: string;
  beforeLine: number; afterLine: number; decision: Decision;
  noteIds?: string[]; requestId?: string; origin?: 'annotation' | 'session' | 'editor';
  parentId?: string;
}
export interface ReviewRequest { id: string; instruction: string; notes: Note[]; anchors: { noteId: string; file: string; line: number; endLine: number }[] }
export interface ReviewFile { file: string; before?: string; proposed?: string; binary: boolean; edits: Edit[] }
export interface Review { version: 1; files: ReviewFile[]; requests?: ReviewRequest[] }
const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
const textBuffer = (value?: string) => value === undefined ? undefined : Buffer.from(value, 'base64');

export function makeReview(changes: Change[], previous?: Review): Review {
  const decisions = new Map(previous?.files.flatMap(f => f.edits.map(e => [e.id, e.decision] as const)) || []);
  return { version: 1, files: changes.map(c => {
    const a = c.before?.toString('utf8') || '', b = c.after?.toString('utf8') || '';
    const binary = !!(c.before?.includes(0) || c.after?.includes(0) || (c.before && !Buffer.from(a).equals(c.before)) || (c.after && !Buffer.from(b).equals(c.after)));
    const edits: Edit[] = [];
    const add = (start: number, end: number, removed: string, inserted: string, afterOffset: number) => {
      const id = digest(Buffer.from(JSON.stringify([c.file, start, removed, inserted]))).slice(0, 24);
      edits.push({ id, file: c.file, start, end, removed, inserted, beforeLine: lineAt(a, start), afterLine: lineAt(b, afterOffset), decision: decisions.get(id) === 'accepted' ? 'accepted' : 'pending' });
    };
    if (binary || !c.before || !c.after) add(0, a.length, a, b, 0);
    else {
      let oldOffset = 0, newOffset = 0;
      let pending: { start: number; end: number; removed: string; inserted: string; after: number } | undefined;
      const flush = () => { if (pending) { add(pending.start, pending.end, pending.removed, pending.inserted, pending.after); pending = undefined; } };
      const parts = diffWordsWithSpace(a, b, { timeout: 3000 });
      if (!parts) add(0, a.length, a, b, 0);
      else parts.forEach((part, index) => {
        if (part.added || part.removed) {
          pending ??= { start: oldOffset, end: oldOffset, removed: '', inserted: '', after: newOffset };
          if (part.removed) { pending.removed += part.value; oldOffset += part.value.length; pending.end = oldOffset; }
          else { pending.inserted += part.value; newOffset += part.value.length; }
        } else {
          // Nearby word replacements form one readable passage; distant edits stay independent.
          if (pending && part.value.length <= 24 && !part.value.includes('\n\n') && parts[index + 1] && (parts[index + 1].added || parts[index + 1].removed)) {
            pending.removed += part.value; pending.inserted += part.value; pending.end += part.value.length;
          } else flush();
          oldOffset += part.value.length; newOffset += part.value.length;
        }
      });
      flush();
    }
    return { file: c.file, before: c.before?.toString('base64'), proposed: c.after?.toString('base64'), binary, edits };
  }) };
}

export function associateReview(review: Review, previous?: Review, request?: ReviewRequest) {
  review.requests = [...(previous?.requests || [])];
  if (request && !review.requests.some(item => item.id === request.id)) review.requests.push(request);
  const old = new Map(previous?.files.flatMap(file => file.edits.map(edit => [edit.id, edit] as const)) || []);
  for (const file of previous?.files || []) for (const edit of file.edits) if (edit.parentId && !old.has(edit.parentId)) old.set(edit.parentId, edit);
  for (const file of review.files) for (const edit of file.edits) {
    const existing = old.get(edit.id);
    if (existing?.origin && existing.decision !== 'rejected') { edit.noteIds = existing.noteIds; edit.requestId = existing.requestId; edit.origin = existing.origin; continue; }
    if (!request) { edit.origin = 'editor'; continue; }
    const endLine = edit.beforeLine + edit.removed.split('\n').length - 1;
    const anchors = request.anchors.filter(anchor => anchor.file === file.file);
    let ids = anchors.filter(anchor => anchor.line <= endLine && anchor.endLine >= edit.beforeLine).map(anchor => anchor.noteId);
    if (!ids.length) {
      const distances = anchors.map(anchor => ({ anchor, distance: Math.max(anchor.line - endLine, edit.beforeLine - anchor.endLine, 0) }));
      const nearest = Math.min(...distances.map(item => item.distance));
      if (nearest <= 2) ids = distances.filter(item => item.distance === nearest).map(item => item.anchor.noteId);
    }
    if (!ids.length && request.notes.length === 1) ids = [request.notes[0].id];
    edit.noteIds = [...new Set(ids)]; edit.requestId = request.id; edit.origin = request.notes.length ? 'annotation' : 'session';
  }
}
export function resolvedNoteIds(review: Review) {
  const linked = new Map<string, Edit[]>();
  for (const file of review.files) for (const edit of file.edits) for (const id of edit.noteIds || []) linked.set(id, [...(linked.get(id) || []), edit]);
  return new Set([...linked].filter(([, edits]) => edits.every(edit => edit.decision === 'accepted')).map(([id]) => id));
}

export function materialize(file: ReviewFile, include: (edit: Edit) => boolean): Buffer | undefined {
  if (file.binary) return include(file.edits[0]) ? textBuffer(file.proposed) : textBuffer(file.before);
  const included = file.edits.map(include);
  if (file.before === undefined && !included.some(Boolean) || file.proposed === undefined && included.every(Boolean)) return undefined;
  const original = textBuffer(file.before)?.toString('utf8') || ''; let result = '', cursor = 0;
  file.edits.forEach((edit, index) => { result += original.slice(cursor, edit.start) + (included[index] ? edit.inserted : edit.removed); cursor = edit.end; });
  return Buffer.from(result + original.slice(cursor));
}
export function reviewPlan(review: Review, acceptedOnly: boolean): Change[] {
  return review.files.flatMap(file => {
    const before = textBuffer(file.before), after = materialize(file, e => acceptedOnly ? e.decision === 'accepted' : e.decision !== 'rejected');
    if (before && after && before.equals(after) || !before && !after) return [];
    return [{ file: file.file, before, after, kind: !before ? 'added' : !after ? 'deleted' : 'modified' } as Change];
  });
}
export function editPosition(file: ReviewFile, target: Edit) {
  let offset = target.start;
  for (const edit of file.edits) { if (edit.id === target.id) break; if (edit.decision !== 'rejected') offset += edit.inserted.length - edit.removed.length; }
  const current = materialize(file, e => e.decision !== 'rejected')?.toString('utf8') || '';
  return { line: lineAt(current, offset), endLine: lineAt(current, offset + (target.decision === 'rejected' ? target.removed.length : target.inserted.length)), offset };
}
export async function saveReview(task: Task, review: Review) {
  const stored = task.mode === 'workspace' ? { version: 2, requests: review.requests, files: review.files.map(({ before, proposed, ...file }) => ({ ...file, beforeExists: before !== undefined, proposedExists: proposed !== undefined, ...(file.binary ? { proposed } : {}) })) } : review;
  await fs.writeFile(path.join(task.dir, 'review.json.tmp'), JSON.stringify(stored));
  await fs.rename(path.join(task.dir, 'review.json.tmp'), path.join(task.dir, 'review.json'));
}
export async function loadReview(task: Task): Promise<Review | undefined> {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(task.dir, 'review.json'), 'utf8'));
    const ignored = await ignoredFiles(task.root, saved.files.map((file: ReviewFile) => file.file));
    saved.files = saved.files.filter((file: ReviewFile) => reviewableFile(file.file, task.main) && !ignored.has(file.file));
    if (saved.version !== 2) return saved;
    const files: ReviewFile[] = [];
    for (const entry of saved.files) {
      const before = entry.beforeExists ? (await fs.readFile(path.join(task.baseline, entry.file))).toString('base64') : undefined;
      const file: ReviewFile = { file: entry.file, binary: entry.binary, edits: entry.edits, before, proposed: entry.proposedExists ? entry.proposed || '' : undefined };
      if (!file.binary && entry.proposedExists) file.proposed = materialize(file, () => true)!.toString('base64');
      files.push(file);
    }
    return { version: 1, files, requests: saved.requests };
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export async function decide(task: Task, review: Review, id: string, decision: Decision) {
  const file = review.files.find(f => f.edits.some(e => e.id === id));
  const edit = file?.edits.find(e => e.id === id); if (!file || !edit) throw new Error('The change has been updated. Select it again.');
  // Validate the exact current proposal before replacing a decision's text.
  const expected = materialize(file, e => e.decision !== 'rejected');
  let current: Buffer | undefined;
  try { current = await fs.readFile(path.join(task.proposal, file.file)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (expected ? !current?.equals(expected) : current !== undefined) throw new Error('The task file has changed. Refresh the review first.');
  const oldDecision = edit.decision; edit.decision = decision;
  const result = materialize(file, e => e.decision !== 'rejected'), target = path.join(task.proposal, file.file);
  try {
    if (result && !current?.equals(result)) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, result); } else if (!result && current) await fs.unlink(target);
    await saveReview(task, review);
  } catch (e) { edit.decision = oldDecision; if (current) await fs.writeFile(target, current); else if (result) await fs.unlink(target); throw e; }
}

export function mapLine(before: string, after: string, oneBasedLine: number): { line: number; changed: boolean } {
  const target = Math.max(0, Math.min(before.length, before.split('\n').slice(0, Math.max(0, oneBasedLine - 1)).join('\n').length + (oneBasedLine > 1 ? 1 : 0)));
  let a = 0, b = 0;
  const parts = diffLines(before, after);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.added) { b += p.value.length; continue; }
    if (target < a + p.value.length || target === a && p.value.length) {
      if (!p.removed) return { line: lineAt(after, b + target - a), changed: false };
      return { line: lineAt(after, Math.min(b, after.length)), changed: true };
    }
    a += p.value.length; if (!p.removed) b += p.value.length;
  }
  return { line: Math.max(1, after.split('\n').length), changed: true };
}
