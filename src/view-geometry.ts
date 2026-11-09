import type { FrameHeader } from './protocol';
export type Bounds = [number, number, number, number];
export interface OverlayLabel { x: number; y: number; width: number; height: number; fallbackX: number }
export function placeOverlayLabels(labels: OverlayLabel[], text: Bounds[], width: number, height: number) {
  const placed: Bounds[] = [], positions = labels.map(label => ({ x: label.x, y: label.y }));
  const overlaps = (a: Bounds, b: Bounds) => a[0] < b[2] + 3 && a[2] + 3 > b[0] && a[1] < b[3] + 3 && a[3] + 3 > b[1];
  const fits = (rect: Bounds) => rect[0] >= -28 && rect[2] <= width + 28 && rect[1] >= 0 && rect[3] <= height && !text.some(box => overlaps(rect, box)) && !placed.some(box => overlaps(rect, box));
  for (const index of labels.map((_, i) => i).sort((a, b) => labels[a].y - labels[b].y || labels[a].x - labels[b].x)) {
    const label = labels[index], y = Math.max(0, Math.min(height - label.height, label.y));
    let rect: Bounds = [Math.max(-28, Math.min(width + 28 - label.width, label.x)), y, 0, y + label.height]; rect[2] = rect[0] + label.width;
    if (!fits(rect)) {
      outer: for (let step = 0; step <= labels.length + 1; step++) for (const direction of [-1, 1]) {
        const top = y + direction * step * (label.height + 4), candidate: Bounds = [label.fallbackX, top, label.fallbackX + label.width, top + label.height];
        if (fits(candidate)) { rect = candidate; break outer; }
      }
    }
    placed.push(rect); positions[index] = { x: rect[0], y: rect[1] };
  }
  return positions;
}

export function horizontalCrop(page: Bounds, ink?: Bounds): Bounds {
  if (!ink || !ink.every(Number.isFinite) || ink[2] <= ink[0]) return [...page];
  const width = page[2] - page[0], limit = width * .2;
  return [Math.max(page[0], Math.min(page[0] + limit, ink[0] - 10)), page[1], Math.min(page[2], Math.max(page[2] - limit, ink[2] + 10)), page[3]];
}

export function inkBounds(page: Bounds, width: number, height: number, rgba: Uint8ClampedArray): Bounds | undefined {
  let left = width, right = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (rgba[i] < 245 || rgba[i + 1] < 245 || rgba[i + 2] < 245) { left = Math.min(left, x); right = Math.max(right, x); }
  }
  return right < left ? undefined : [page[0] + left / width * (page[2] - page[0]), page[1], page[0] + (right + 1) / width * (page[2] - page[0]), page[3]];
}

export function surfaceTransform(page: Bounds, crop: Bounds) {
  const width = crop[2] - crop[0];
  return { left: (page[0] - crop[0]) / width * 100, width: (page[2] - page[0]) / width * 100, aspectRatio: width / (page[3] - page[1]) };
}

export function sourcePoint(bounds: Bounds, surface: { left: number; top: number; width: number; height: number }, x: number, y: number) {
  return [bounds[0] + Math.max(0, Math.min(1, (x - surface.left) / surface.width)) * (bounds[2] - bounds[0]), bounds[1] + Math.max(0, Math.min(1, (y - surface.top) / surface.height)) * (bounds[3] - bounds[1])];
}

export function nearestTextPoint(characters: [number, number, number, number, number][], x: number, y: number): [number, number] | undefined {
  let nearest: typeof characters[number] | undefined, distance = Infinity;
  const lines = textLines(characters), body = lines.filter(line => !/^\d+$/.test(line.glyphs.map(g => String.fromCodePoint(g.code)).join('').trim()));
  const left = body.length ? Math.min(...body.map(line => line.bounds[0])) : -Infinity;
  const margin = new Set(lines.filter(line => line.bounds[2] < left).flatMap(line => line.glyphs.map(g => g.index)));
  for (const [index, glyph] of characters.entries()) {
    const [code, left, top, right, bottom] = glyph;
    if (margin.has(index) || right <= left || bottom <= top || /\s/.test(String.fromCodePoint(code))) continue;
    const dx = Math.max(left - x, 0, x - right), dy = Math.max(top - y, 0, y - bottom), d = dx * dx + dy * dy;
    if (d === 0) return [x, y];
    if (d < distance) { nearest = glyph; distance = d; }
  }
  return nearest ? [(nearest[1] + nearest[3]) / 2, (nearest[2] + nearest[4]) / 2] : undefined;
}

export interface TextContext { words: string[]; index: number }
export function textTokens(text: string) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)].map(match => ({ word: match[0].normalize('NFKC').toLowerCase().replaceAll('’', "'"), offset: match.index!, length: match[0].length }));
}
export function textContext(characters: [number, number, number, number, number][], x: number, y: number): TextContext | undefined {
  const line = textLines(characters).find(line => line.glyphs.some(g => x >= g.bounds[0] && x <= g.bounds[2] && y >= g.bounds[1] && y <= g.bounds[3]));
  if (!line) return;
  let offset = 0, caret = 0, text = '';
  for (const glyph of line.glyphs) {
    if (x >= glyph.bounds[0] && x <= glyph.bounds[2]) caret = offset;
    const value = glyph.code ? String.fromCodePoint(glyph.code) : '�'; text += value; offset += value.length;
  }
  const tokens = textTokens(text); if (!tokens.length) return;
  let index = 0, distance = Infinity;
  tokens.forEach((token, i) => { const d = Math.max(token.offset - caret, 0, caret - token.offset - token.length); if (d < distance) { distance = d; index = i; } });
  const start = Math.max(0, index - 6), end = Math.min(tokens.length, index + 7);
  return { words: tokens.slice(start, end).map(t => t.word), index: index - start };
}

export interface TextGlyph { index: number; code: number; bounds: Bounds }
export interface TextLine { glyphs: TextGlyph[]; bounds: Bounds }
export function textLines(characters: [number, number, number, number, number][]): TextLine[] {
  const result: TextLine[] = []; let glyphs: TextGlyph[] = [];
  const flush = () => {
    if (glyphs.length) result.push({ glyphs, bounds: [Math.min(...glyphs.map(g => g.bounds[0])), Math.min(...glyphs.map(g => g.bounds[1])), Math.max(...glyphs.map(g => g.bounds[2])), Math.max(...glyphs.map(g => g.bounds[3]))] });
    glyphs = [];
  };
  characters.forEach((c, index) => { if (c[0] === 10) flush(); else if (c[3] > c[1] && c[4] > c[2]) glyphs.push({ index, code: c[0], bounds: c.slice(1) as Bounds }); });
  flush(); return result;
}
export function lineCaret(line: TextLine, x: number) {
  const index = line.glyphs.findIndex(glyph => x < (glyph.bounds[0] + glyph.bounds[2]) / 2);
  return index < 0 ? line.glyphs.length : index;
}
export function textCaret(lines: TextLine[], x: number, y: number, origin?: TextLine) {
  let nearest: TextLine | undefined, vertical = Infinity, horizontal = Infinity;
  for (const line of lines) {
    const [left, top, right, bottom] = line.bounds;
    if (origin && (right < origin.bounds[0] || left > origin.bounds[2])) continue;
    const dy = Math.max(top - y, 0, y - bottom), dx = Math.max(left - x, 0, x - right);
    if (dy < vertical || dy === vertical && dx < horizontal) { nearest = line; vertical = dy; horizontal = dx; }
  }
  return nearest ? { line: nearest, offset: lineCaret(nearest, x) } : undefined;
}

function marginGlyphs(chars: NonNullable<FrameHeader['characters']>) {
  const lines = textLines(chars), body = lines.filter(line => !/^\d+$/.test(line.glyphs.map(g => String.fromCodePoint(g.code)).join('').trim()));
  const left = body.length ? Math.min(...body.map(line => line.bounds[0])) : -Infinity;
  return new Set(lines.filter(line => line.bounds[2] < left).flatMap(line => line.glyphs.map(g => g.index)));
}
export function pageText(header: FrameHeader, omitMargin = false) {
  let text = '', joined = false; const indices: number[] = [], chars = header.characters || [], margin = omitMargin ? marginGlyphs(chars) : new Set<number>();
  chars.forEach((c, i) => {
    if (margin.has(i)) return;
    if (c[0] === 45 && /\p{L}$/u.test(text) && /^[ \t]*\n\s*\p{L}/u.test(chars.slice(i + 1, i + 40).map(c => String.fromCodePoint(c[0])).join(''))) { joined = true; return; }
    if (joined && /\s/.test(String.fromCodePoint(c[0]))) return;
    joined = false;
    const value = c[0] === 0 ? '�' : String.fromCodePoint(c[0]).normalize('NFKC');
    if (/\s/.test(value)) { if (text.endsWith(' ')) return; text += ' '; indices.push(i); }
    else { text += value; for (let n = 0; n < value.length; n++) indices.push(i); }
  });
  return { text, indices };
}
export function quoteGeometry(header: FrameHeader, quote: string, near?: number[]): number[][] | undefined {
  const target = quote.replaceAll('\u0000', '�').normalize('NFKC').replace(/(?<=\p{L})-\s*\n\s*(?=\p{L})/gu, '').replace(/\s+/g, ' ').trim(); if (!target) return;
  const { text, indices } = pageText(header), chars = header.characters || [];
  let best = -1, distance = Infinity;
  for (let i = text.indexOf(target); i >= 0; i = text.indexOf(target, i + 1)) {
    const c = chars[indices[i]], d = near ? Math.hypot(c[1] - near[0], c[2] - near[1]) : i;
    if (d < distance) { best = i; distance = d; }
  }
  if (best < 0) return;
  return textRangeGeometry(header, indices[best], indices[best + target.length - 1]);
}
export function textRangeGeometry(header: FrameHeader, start: number, end: number, omitMargin = false): number[][] | undefined {
  const chars = header.characters || [], margin = omitMargin ? marginGlyphs(chars) : new Set<number>();
  const result: number[][] = [];
  for (let i = start; i <= end; i++) {
    const c = chars[i]; if (margin.has(i) || c[0] === 10 || c[3] <= c[1] || c[4] <= c[2]) continue;
    const r = c.slice(1), previous = result[result.length - 1];
    if (previous && Math.abs((previous[1] + previous[3] - r[1] - r[3]) / 2) < 4 && r[0] <= previous[2] + 5) {
      previous[0] = Math.min(previous[0], r[0]); previous[1] = Math.min(previous[1], r[1]); previous[2] = Math.max(previous[2], r[2]); previous[3] = Math.max(previous[3], r[3]);
    } else result.push(r);
  }
  return result.length ? result : undefined;
}
