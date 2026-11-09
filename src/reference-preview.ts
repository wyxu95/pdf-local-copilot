import type { FrameHeader } from './protocol';
import { textLines, type Bounds } from './view-geometry';

export type ReferenceKind = 'Reference' | 'Figure' | 'Table';
export interface ReferencePoint { name: string; x: number; y: number }
export interface ReferenceRaster { width: number; height: number; data: Uint8ClampedArray }
export function referenceKind(name: string): ReferenceKind {
  return /^(?:sub)?figure[.]/i.test(name) ? 'Figure' : /^table[.]/i.test(name) ? 'Table' : 'Reference';
}
export function referenceLinkAt(header: FrameHeader, x: number, y: number) {
  const index = header.annotations?.links.findIndex(link => link.uri.startsWith('#') && x >= link.bounds[0] - 1 && x <= link.bounds[2] + 1 && y >= link.bounds[1] - 1 && y <= link.bounds[3] + 1) ?? -1;
  return index < 0 ? undefined : { index, link: header.annotations!.links[index] };
}
export function referenceLabel(header: FrameHeader, bounds: Bounds) {
  return (header.characters || []).filter(char => char[0] !== 10 && (char[1] + char[3]) / 2 >= bounds[0] && (char[1] + char[3]) / 2 <= bounds[2] && (char[2] + char[4]) / 2 >= bounds[1] && (char[2] + char[4]) / 2 <= bounds[3]).map(char => char[0] ? String.fromCodePoint(char[0]) : '�').join('').trim().slice(0, 80);
}
export function referencePreviewBounds(header: FrameHeader, target: ReferencePoint, kind: ReferenceKind, raster?: ReferenceRaster): Bounds {
  const page = header.bounds, destinations = header.annotations?.destinations || [];
  const lines = textLines(header.characters || []).map(line => ({ ...line, text: line.glyphs.map(glyph => glyph.code ? String.fromCodePoint(glyph.code) : '�').join('').trim() })).filter(line => line.text && !/^\d+$/.test(line.text));
  const bodyLeft = lines.length ? Math.min(...lines.map(line => line.bounds[0])) : page[0] + 20;
  const bodyRight = lines.length ? Math.max(...lines.map(line => line.bounds[2])) : page[2] - 20;
  const columns: number[] = [];
  for (const x of [...destinations.filter(dest => /^cite[.]/i.test(dest.name)).map(dest => dest.x), target.x].sort((a, b) => a - b)) if (!columns.length || x - columns.at(-1)! > (page[2] - page[0]) * .18) columns.push(x);
  const column = columns.reduce((best, x, i) => Math.abs(x - target.x) < Math.abs(columns[best] - target.x) ? i : best, 0);
  const indent = Math.max(0, Math.min(40, columns[0] - bodyLeft));
  let left = Math.max(page[0], columns[column] - indent - 8), right = Math.min(page[2], column + 1 < columns.length ? columns[column + 1] - indent - 8 : bodyRight + 8);
  if (right <= left + 20) { left = Math.max(page[0], bodyLeft - 8); right = Math.min(page[2], bodyRight + 8); }
  if (kind !== 'Reference') { left = page[0] + 8; right = page[2] - 8; }
  const columnLines = lines.filter(line => line.bounds[0] < right - 4 && line.bounds[2] > left + 4).sort((a, b) => a.bounds[1] - b.bounds[1]);
  const nearest = kind === 'Reference' ? columnLines.find(line => line.bounds[3] >= target.y) : columnLines.slice().sort((a, b) => Math.max(a.bounds[1] - target.y, 0, target.y - a.bounds[3]) - Math.max(b.bounds[1] - target.y, 0, target.y - b.bounds[3]))[0];
  let top = nearest?.bounds[1] ?? target.y, bottom = nearest?.bounds[3] ?? target.y + 20;
  const following = destinations.filter(dest => dest.name !== target.name && dest.y > target.y + 4 && dest.x >= left && dest.x < right);
  if (kind === 'Reference') {
    const next = following.filter(dest => /^(cite|section)[.*]/i.test(dest.name)).sort((a, b) => a.y - b.y)[0];
    const selected = columnLines.filter(line => line.bounds[1] >= top - 2 && (!next || line.bounds[1] < next.y - 2));
    for (const line of selected) {
      if (!next && line.bounds[1] > top + 3 && (/^\[\d+\]|^\d+[.)]\s/.test(line.text) || line.bounds[1] - bottom > Math.max(9, (line.bounds[3] - line.bounds[1]) * .9))) break;
      bottom = Math.max(bottom, line.bounds[3]);
    }
  } else {
    const captions = columnLines.filter(line => (kind === 'Figure' ? /^(?:Figure|Fig[.]?)\s*\d/i : /^(?:Table|Tab[.]?)\s*\d/i).test(line.text));
    const caption = captions.sort((a, b) => Math.abs(a.bounds[1] - target.y) - Math.abs(b.bounds[1] - target.y))[0];
    if (caption && Math.abs(caption.bounds[1] - target.y) < 450) { top = caption.bounds[1]; bottom = caption.bounds[3]; }
    const blocks: [number, number][] = [];
    if (raster) {
      const sx = raster.width / (page[2] - page[0]), sy = raster.height / (page[3] - page[1]), x0 = Math.max(0, Math.floor((left - page[0]) * sx)), x1 = Math.min(raster.width, Math.ceil((right - page[0]) * sx));
      let start = -1, last = -1;
      for (let y = 0; y < raster.height; y++) {
        let ink = false;
        for (let x = x0; x < x1; x += 2) { const i = (y * raster.width + x) * 4; if (raster.data[i] < 235 || raster.data[i + 1] < 235 || raster.data[i + 2] < 235) { ink = true; break; } }
        if (ink) { if (start < 0) start = y; last = y; }
        if (start >= 0 && (y - last > 6 * sy || y === raster.height - 1)) { blocks.push([page[1] + start / sy, page[1] + (last + 1) / sy]); start = -1; }
      }
    }
    const at = blocks.reduce((best, block, i) => Math.max(block[0] - top, 0, top - block[1]) < Math.max(blocks[best][0] - top, 0, top - blocks[best][1]) ? i : best, 0);
    if (blocks.length) {
      const block = blocks[at]; top = block[0]; bottom = block[1];
      if (target.y < top - 20) top = target.y;
      else {
        const preferred = kind === 'Figure' ? blocks[at - 1] : blocks[at + 1], alternate = kind === 'Figure' ? blocks[at + 1] : blocks[at - 1];
        const adjacent = [preferred, ...(bottom - top < 32 && alternate && alternate[1] - alternate[0] > 16 ? [alternate] : [])].find(candidate => candidate && Math.max(top - candidate[1], candidate[0] - bottom) < 40);
        if (adjacent) { top = Math.min(top, adjacent[0]); bottom = Math.max(bottom, adjacent[1]); }
      }
    } else { top = Math.min(target.y, top) - (kind === 'Figure' && Math.abs(target.y - top) < 20 ? 180 : 6); bottom = Math.max(bottom, target.y + (kind === 'Table' ? 180 : 30)); }
    const next = following.filter(dest => /^(figure|table|section)[.*]/i.test(dest.name)).sort((a, b) => a.y - b.y)[0];
    if (next) bottom = Math.min(bottom, next.y - 4);
    if (raster) {
      const sx = raster.width / (page[2] - page[0]), sy = raster.height / (page[3] - page[1]);
      const margin = textLines(header.characters || []).filter(line => /^\d+$/.test(line.glyphs.map(glyph => String.fromCodePoint(glyph.code)).join('').trim()) && line.bounds[2] < bodyLeft && line.bounds[2] < page[0] + (page[2] - page[0]) * .2);
      const x0 = Math.max(0, Math.floor(((margin.length ? Math.max(...margin.map(line => line.bounds[2])) + 3 : page[0]) - page[0]) * sx));
      let min = raster.width, max = -1;
      for (let y = Math.max(0, Math.floor((top - page[1]) * sy)); y < Math.min(raster.height, Math.ceil((bottom - page[1]) * sy)); y++) for (let x = x0; x < raster.width; x += 2) {
        const i = (y * raster.width + x) * 4;
        if (raster.data[i] < 235 || raster.data[i + 1] < 235 || raster.data[i + 2] < 235) { min = Math.min(min, x); max = Math.max(max, x); }
      }
      if (max >= min) { left = Math.max(page[0], page[0] + min / sx - 6); right = Math.min(page[2], page[0] + (max + 1) / sx + 6); }
    }
  }
  return [left, Math.max(page[1], top - 6), right, Math.min(page[3], Math.max(top + 12, bottom) + 6)];
}
