import { diffArrays } from 'diff';
import type { FrameHeader } from './protocol';
import { pageText, textRangeGeometry } from './view-geometry';

interface Word { word: string; offset: number; length: number }
const words = (text: string): Word[] => [...text.matchAll(/[\p{L}\p{N}�]+(?:[-'’][\p{L}\p{N}�]+)*/gu)].map(match => ({ word: match[0].normalize('NFKC').toLowerCase().replaceAll('’', "'"), offset: match.index!, length: match[0].length }));
const blank = (text: string) => ' '.repeat(text.length);
function visibleLatex(source: string) {
  return source.replace(/(?<!\\)%[^\r\n]*/g, blank)
    .replace(/\\(?:[a-zA-Z]*cite[a-zA-Z]*|label|(?:[a-zA-Z]*ref)|begin|end|bibliography|bibliographystyle|includegraphics|input|include)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g, blank)
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, blank);
}
function sameWord(a: string, b: string) {
  if (a === b) return true;
  const unknown = a.includes('�') ? a : b.includes('�') ? b : undefined;
  return !!unknown && new RegExp('^' + unknown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('�', '[a-z]{1,3}') + '$').test(unknown === a ? b : a);
}
export interface PdfRange { page: number; rects: number[][]; bounds: number[] }

export function alignReviewSource(source: string, headers: FrameHeader[]) {
  const sourceWords = words(visibleLatex(source));
  const pdfWords: (Word & { page: number; start: number; end: number })[] = [];
  const pages = new Map(headers.map(header => [header.page, header]));
  for (const header of [...headers].sort((a, b) => a.page - b.page)) {
    const projection = pageText(header, true);
    for (const word of words(projection.text)) pdfWords.push({ ...word, page: header.page, start: projection.indices[word.offset], end: projection.indices[word.offset + word.length - 1] });
  }
  const parts = diffArrays(sourceWords.map(word => word.word), pdfWords.map(word => word.word), { comparator: sameWord, timeout: 1500 });
  const matched = new Map<number, number>(); let old = 0, current = 0;
  for (const part of parts || []) {
    if (part.removed) old += part.count;
    else if (part.added) current += part.count;
    else for (let i = 0; i < part.count; i++) matched.set(old++, current++);
  }
  return (offset: number, length: number): PdfRange[] => {
    const selected = sourceWords.flatMap((word, i) => word.offset < offset + length && word.offset + word.length > offset && matched.has(i) ? [matched.get(i)!] : []);
    if (!selected.length) return [];
    const ranges: PdfRange[] = [];
    for (const [page, header] of pages) {
      const onPage = selected.map(index => pdfWords[index]).filter(word => word.page === page); if (!onPage.length) continue;
      const rects = textRangeGeometry(header, onPage[0].start, onPage[onPage.length - 1].end, true);
      if (rects?.length) ranges.push({ page, rects, bounds: header.bounds });
    }
    return ranges;
  };
}
