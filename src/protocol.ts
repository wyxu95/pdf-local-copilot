import type { Readable } from 'node:stream';

export interface PdfDestination { name: string; x: number; y: number }
export interface PdfLink { bounds: [number, number, number, number]; uri: string; target?: { page: number; x: number; y: number } }

export interface FrameHeader {
  requestId: number; revision: number; sequence: number; page: number;
  bounds: [number, number, number, number]; width: number; height: number;
  mime: 'image/png' | 'image/svg+xml'; byteLength: number;
  characters?: [number, number, number, number, number][];
  annotations?: { links: PdfLink[]; destinations?: PdfDestination[] };
}
export interface Frame { header: FrameHeader; bytes: Buffer }

export function readFrames(input: Readable, message: (value: unknown[]) => void,
  frame: (value: Frame) => void, failure: (error: Error) => void) {
  let pending = Buffer.alloc(0), header: FrameHeader | undefined, closed = false;
  const close = () => { closed = true; input.off('data', data); input.off('end', end); pending = Buffer.alloc(0); };
  const fail = (e: unknown) => { close(); failure(e instanceof Error ? e : new Error(String(e))); };
  const data = (chunk: Buffer) => {
    try {
      pending = Buffer.concat([pending, chunk]);
      while (!closed) {
        if (header) {
          if (pending.length < header.byteLength) break;
          const value = { header, bytes: pending.subarray(0, header.byteLength) };
          pending = pending.subarray(header.byteLength); header = undefined;
          frame(value);
        } else {
          const newline = pending.indexOf(10);
          if (newline < 0) { if (pending.length > 2 * 1024 * 1024) throw new Error('TeXpresso header exceeds 2 MiB.'); break; }
          if (newline > 2 * 1024 * 1024) throw new Error('TeXpresso header exceeds 2 MiB.');
          const line = pending.subarray(0, newline).toString('utf8'); pending = pending.subarray(newline + 1);
          if (!line.trim()) continue;
          const value = JSON.parse(line);
          if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error('Invalid TeXpresso notification.');
          if (value[0] !== 'preview-image') { message(value); continue; }
          const h = value[1] as FrameHeader;
          if (!h || ![h.byteLength, h.requestId, h.revision, h.sequence, h.page, h.width, h.height].every(n => Number.isSafeInteger(n) && n >= 0) ||
            h.byteLength < 1 || h.byteLength > 16 * 1024 * 1024 || h.width < 1 || h.height < 1 || h.width > 8192 || h.height > 8192 ||
            !['image/png', 'image/svg+xml'].includes(h.mime) || !Array.isArray(h.bounds) || h.bounds.length !== 4 || !h.bounds.every(Number.isFinite) ||
            h.bounds[2] <= h.bounds[0] || h.bounds[3] <= h.bounds[1]) throw new Error('Invalid TeXpresso frame.');
          if (h.characters !== undefined && (!Array.isArray(h.characters) || h.characters.length > 12000 ||
            !h.characters.every(c => Array.isArray(c) && c.length === 5 && c.every(Number.isFinite) && Number.isInteger(c[0]) && c[0] >= 0 && c[0] <= 0x10ffff))) {
            throw new Error('Invalid TeXpresso text layer.');
          }
          header = h;
        }
      }
    } catch (e) { fail(e); }
  };
  const end = () => { if (header || pending.length) fail(new Error('TeXpresso closed during a frame.')); else close(); };
  input.on('data', data); input.on('end', end);
  return { close };
}
