import { execFile } from 'node:child_process';
import path from 'node:path';
import { diffChars } from 'diff';
import { digest, inside } from './project';
import { materialize, editPosition, type Review, type ReviewFile, type Edit } from './review';

const git = (root: string, args: string[]) => new Promise<Buffer>((resolve, reject) => execFile('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
export async function gitHead(root: string) {
  try { const head = (await git(root, ['rev-parse', 'HEAD'])).toString().trim(); return /^[a-f0-9]{40,64}$/.test(head) ? head : undefined; } catch { return; }
}
export async function committedReviewFiles(root: string, previous: string | undefined, head: string, names: string[]) {
  const files = new Map<string, Buffer | undefined>();
  if (previous === head) return files;
  // Include files touched by intervening commits even if they later return to their original contents.
  const changed = previous ? new Set((await git(root, ['log', '--format=', '--name-only', '--no-renames', '--relative', '-z', `${previous}..${head}`, '--', '.'])).toString().split('\0')) : new Set(names);
  for (const file of names) if (changed.has(file) && inside(root, path.resolve(root, file))) {
    const entry = (await git(root, ['ls-tree', '-z', head, '--', `:(literal)${file.split(path.sep).join('/')}`])).toString();
    if (!entry) { files.set(file, undefined); continue; }
    const metadata = entry.slice(0, entry.indexOf('\t')).split(' ');
    if (metadata[1] === 'blob' && /^100[67]/.test(metadata[0])) files.set(file, await git(root, ['cat-file', 'blob', metadata[2]]));
  }
  return files;
}

function equalPositions(before: string, after: string) {
  const result = new Map<number, number>(); let a = 0, b = 0;
  const parts = diffChars(before, after, { timeout: 1000 }); if (!parts) return;
  for (const part of parts) {
    if (part.removed) a += part.value.length;
    else if (part.added) b += part.value.length;
    else for (let i = 0; i < part.value.length; i++) result.set(a++, b++);
  }
  return result;
}
function splitCommittedEdit(file: ReviewFile, edit: Edit, before: string, committed: string, oldPositions: Map<number, number>, newPositions: Map<number, number>): Edit[] {
  const parts = diffChars(edit.removed, edit.inserted, { timeout: 1000 }); if (!parts) return [edit];
  let old = edit.start, next = editPosition(file, edit).offset;
  const edits: Edit[] = [];
  const append = (start: number, removed: string, inserted: string, accepted: boolean) => {
    const decision = accepted ? 'accepted' : 'pending', last = edits.at(-1);
    if (last?.decision === decision) {
      const bridge = before.slice(last.end, start); last.removed += bridge + removed; last.inserted += bridge + inserted; last.end = start + removed.length;
    } else edits.push({ ...edit, id: '', start, end: start + removed.length, removed, inserted, decision });
  };
  for (const part of parts) {
    if (!part.added && !part.removed) { old += part.value.length; next += part.value.length; continue; }
    for (const character of part.value) {
      const accepted = part.removed ? !oldPositions.has(old) : newPositions.has(next);
      append(old, part.removed ? character : '', part.added ? character : '', accepted);
      if (part.removed) old += character.length; else next += character.length;
    }
  }
  if (!edits.some(part => part.decision === 'accepted')) return [edit];
  const left = edit.start === 0 ? 0 : oldPositions.get(edit.start - 1), right = edit.end === before.length ? committed.length : oldPositions.get(edit.end);
  if (left === undefined || right === undefined) return [edit];
  let expected = '', cursor = edit.start;
  for (const part of edits) { expected += before.slice(cursor, part.start) + (part.decision === 'accepted' ? part.inserted : part.removed); cursor = part.end; }
  expected += before.slice(cursor, edit.end);
  // Approve a split only when its complete result matches the commit between unchanged neighbours.
  if (committed.slice(edit.start === 0 ? 0 : left + 1, right) !== expected) return [edit];
  if (edits.every(part => part.decision === 'accepted')) return [{ ...edit, decision: 'accepted' }];
  return edits.map((part, index) => ({ ...part, parentId: edit.parentId || edit.id, id: digest(Buffer.from(JSON.stringify([edit.id, index, part.start, part.removed, part.inserted]))).slice(0, 24), beforeLine: before.slice(0, part.start).split('\n').length }));
}

export function acceptCommittedReview(review: Review, committed: ReadonlyMap<string, Buffer | undefined>) {
  let accepted = 0;
  const files = review.files.map(file => {
    if (!committed.has(file.file) || !file.edits.some(edit => edit.decision === 'pending')) return file;
    const bytes = committed.get(file.file), current = materialize(file, edit => edit.decision !== 'rejected');
    if (bytes === undefined && current === undefined || bytes && current?.equals(bytes)) {
      return { ...file, edits: file.edits.map(edit => { if (edit.decision !== 'pending') return edit; accepted++; return { ...edit, decision: 'accepted' as const }; }) };
    }
    if (file.binary || bytes === undefined) return file;
    const before = Buffer.from(file.before || '', 'base64').toString('utf8'), proposed = current?.toString('utf8') || '', raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) return file;
    const text = raw.replace(/\r?\n/g, (proposed || before).includes('\r\n') ? '\r\n' : '\n');
    if (current !== undefined && proposed === text) return { ...file, edits: file.edits.map(edit => { if (edit.decision !== 'pending') return edit; accepted++; return { ...edit, decision: 'accepted' as const }; }) };
    const oldPositions = equalPositions(before, text), newPositions = equalPositions(proposed, text);
    if (!oldPositions || !newPositions) return file;
    const edits = file.edits.flatMap(edit => {
      if (edit.decision !== 'pending') return [edit];
      const parts = splitCommittedEdit(file, edit, before, text, oldPositions, newPositions);
      accepted += parts.filter(part => part.decision === 'accepted').length; return parts;
    });
    const result = { ...file, edits: edits.map(edit => ({ ...edit })) };
    // Committing an empty file confirms its contents, while deletion of the file can remain unstaged.
    if (file.proposed === undefined && result.edits.every(edit => edit.decision === 'accepted')) {
      const parent = file.edits[0];
      result.edits.push({ ...parent, parentId: parent.parentId || parent.id, id: digest(Buffer.from(parent.id + ':file-deletion')).slice(0, 24), start: before.length, end: before.length, removed: '', inserted: '', decision: 'pending' });
    }
    for (const edit of result.edits) edit.afterLine = editPosition(result, edit).line;
    return result;
  });
  return { review: { ...review, files }, accepted };
}
