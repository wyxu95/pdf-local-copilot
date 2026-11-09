import type { Note } from './agent';
import type { Frame, FrameHeader } from './protocol';
import { mapLine } from './review';
import { quoteGeometry } from './view-geometry';

export function trackNotes(notes: Note[], file: string, before: string, after: string): boolean {
  if (before === after) return false;
  let changed = false;
  for (const note of notes) {
    if (note.source?.file !== file) continue;
    const start = mapLine(before, after, note.source.line), end = mapLine(before, after, note.source.endLine || note.source.line);
    const lines = after.split(/\r?\n/);
    note.source.line = Math.min(start.line, Math.max(1, lines.length)); note.source.endLine = Math.max(note.source.line, Math.min(end.line, lines.length));
    note.source.text = lines.slice(Math.max(0, note.source.line - 3), Math.min(lines.length, note.source.endLine + 2)).join('\n');
    if (start.changed) {
      const anchor = note.source.anchor;
      if (anchor && after.includes(anchor) && after.indexOf(anchor) === after.lastIndexOf(anchor)) {
        note.source.line = after.slice(0, after.indexOf(anchor)).split('\n').length;
        note.source.endLine = note.source.line + anchor.split('\n').length - 1; note.anchorStatus = 'anchored';
      } else note.anchorStatus = after.trim() && note.source.text.trim() ? 'modified' : 'orphaned';
    } else note.anchorStatus = 'anchored';
    changed = true;
  }
  return changed;
}

export { quoteGeometry } from './view-geometry';
export async function locateAnnotation(note: Note, point: { page: number; x: number; y: number } | undefined, pages: number, readPage: (page: number) => Promise<Frame>) {
  if (note.region) {
    if (!point) return;
    const rects = regionGeometry((await readPage(point.page)).header, note, point.x, point.y);
    return rects ? { page: point.page, rects } : undefined;
  }
  for (const page of new Set([note.page, ...(point ? [point.page] : []), ...Array.from({ length: pages }, (_, page) => page)])) {
    if (page < 0 || page >= pages) continue;
    const rects = quoteGeometry((await readPage(page)).header, note.quote, note.rects[0]);
    if (rects) return { page, rects };
  }
}
export function nearbyGeometry(header: FrameHeader, x: number, y: number): number[][] {
  const chars = (header.characters || []).filter(c => c[0] !== 10 && c[3] > c[1] && c[4] > c[2]);
  const closest = chars.reduce<typeof chars[number] | undefined>((best, c) => !best || Math.hypot(c[1] - x, (c[2] + c[4]) / 2 - y) < Math.hypot(best[1] - x, (best[2] + best[4]) / 2 - y) ? c : best, undefined);
  if (!closest) return [[x - 4, y - 7, x + 24, y + 7]];
  const line = chars.filter(c => Math.abs((c[2] + c[4] - closest[2] - closest[4]) / 2) < 4);
  return [[Math.min(...line.map(c => c[1])), Math.min(...line.map(c => c[2])), Math.max(...line.map(c => c[3])), Math.max(...line.map(c => c[4]))]];
}
export function regionGeometry(header: FrameHeader, note: Note, x: number, y: number): number[][] | undefined {
  if (!note.region) return;
  const r = note.region, b = header.bounds;
  const rect = [Math.max(b[0], x + r.dx), Math.max(b[1], y + r.dy), Math.min(b[2], x + r.dx + r.width), Math.min(b[3], y + r.dy + r.height)];
  return rect[2] > rect[0] && rect[3] > rect[1] ? [rect] : undefined;
}
