import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFrames, type Frame, type FrameHeader, type PdfLink } from './protocol';
import { launch, localEnvironment, terminate } from './process';
import { inside } from './project';
import { externalPosition, externalLocation } from './synctex';

export interface Location { file: string; line: number; column: number; word?: string }
export interface PagePoint { page: number; x: number; y: number }
export interface LiveOptions { includeDirectories?: string[]; pdf?: string }
export interface LiveEvents {
  frame(frame: Frame): void;
  state(value: { revision: number; sequence: number; pages: number; complete: boolean; stale: boolean; pending: boolean }): void;
  log(text: string): void;
  error(error: Error): void;
}

export async function probe(binary: string) {
  return new Promise<void>((resolve, reject) => {
    execFile(binary, ['-capabilities'], { env: localEnvironment(), timeout: 4000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) { reject(new Error(`Cannot run TeXpresso at ${binary}: ${error.message}. Run npm run native:build, or set pdfLocal.texpressoPath.`)); return; }
      try {
        const capabilities = JSON.parse(stdout);
        if (capabilities.previewProtocol !== 1 || !capabilities.codecs?.includes('png') || !capabilities.synctex) throw new Error('This TeXpresso build needs the headless preview protocol. See README for the pinned build.');
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

export class LivePreview {
  private child?: ReturnType<typeof launch>;
  private reader?: ReturnType<typeof readFrames>;
  private sequence = 0;
  private revision = 0;
  private acknowledged = -1;
  private requestId = 0;
  private inFlight = 0;
  private page = 0;
  private pages = 0;
  private complete = false;
  private stopped = false;
  private inverse?: { resolve: (location: Location) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private inverseTail: Promise<unknown> = Promise.resolve();
  private syncTimer?: NodeJS.Timeout;
  private opened = new Map<string, string>();
  private physicalRoot?: string;
  private auxiliaryBusy = false;
  private auxiliaryTail: Promise<unknown> = Promise.resolve();
  private exports = new Map<number, { resolve: (frame: Frame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private searches = new Map<number, { resolve: (point: PagePoint) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private destinations = new Map<string, { resolve: (page: number) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; sequence: number }>();
  private cache = new Map<number, Frame>();
  private externalPending = false;
  lastFrame?: Frame;
  constructor(readonly binary: string, readonly root: string, readonly main: string, private events: LiveEvents, private options: LiveOptions = {}) {}

  async start() {
    await probe(this.binary);
    this.physicalRoot = await fs.realpath(this.root);
    if (this.stopped) return;
    const child = launch(this.binary, ['-headless', '-json', '-lines', '-texlive', ...(this.options.includeDirectories || []).flatMap(p => ['-I', p]), this.options.pdf || this.main], path.dirname(this.main));
    this.child = child;
    child.on('error', e => this.events.error(e));
    child.stdin.on('error', e => { if (!this.stopped) this.events.error(e); });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (s: string) => this.events.log(s));
    child.once('close', (code, signal) => {
      if (!this.stopped) this.events.error(new Error(`TeXpresso exited (${signal || code}). Check compiler output.`));
      void terminate(child).catch(e => { if (!this.stopped) this.events.error(e); });
    });
    this.reader = readFrames(child.stdout, value => this.message(value), value => this.acceptFrame(value), e => this.events.error(e));
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    this.send(['rerun', true]);
  }

  private send(value: unknown[]) { if (!this.stopped && this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  snapshot() { return { revision: this.revision, sequence: this.sequence, pages: this.pages, complete: this.complete, stale: this.externalPending || this.lastFrame?.header.sequence !== this.sequence || this.lastFrame?.header.revision !== this.revision, pending: this.externalPending }; }
  private state(stale = true) { this.events.state({ ...this.snapshot(), stale: stale || this.externalPending }); }
  buildPending(value: boolean) { if (this.options.pdf) { this.externalPending = value; if (value) this.state(); } }
  private message(v: unknown[]) {
    if (v[0] === 'preview-destination') {
      const name = String(v[3]), pending = this.destinations.get(name);
      if (pending) {
        clearTimeout(pending.timer); this.destinations.delete(name);
        if (v[2] !== pending.sequence || pending.sequence !== this.sequence) pending.reject(new Error('The reference changed during lookup.'));
        else if (Number(v[4]) < 0) pending.reject(new Error('The reference target was not found.'));
        else pending.resolve(Number(v[4]));
      }
      return;
    }
    if (v[0] === 'preview-source') {
      const waiting = this.searches.get(Number(v[1]));
      if (waiting) { clearTimeout(waiting.timer); this.searches.delete(Number(v[1])); if (v[3] !== this.sequence) waiting.reject(new Error('Source changed during search.')); else waiting.resolve({ page: Number(v[4]), x: Number(v[5]), y: Number(v[6]) }); }
      return;
    }
    if (v[0] === 'preview-state' || v[0] === 'preview-invalidated') {
      if (!Number.isSafeInteger(v[1]) || !Number.isSafeInteger(v[2]) || Number(v[2]) < this.sequence) return;
      const changed = this.revision !== v[1] || this.acknowledged !== v[2];
      this.revision = Number(v[1]); this.acknowledged = Number(v[2]);
      if (changed) { this.inFlight = 0; this.cancelInverse(); }
      if (v[0] === 'preview-state') { this.pages = Number(v[3]); this.complete = v[4] === true; }
      this.state(this.lastFrame?.header.revision !== this.revision || this.lastFrame?.header.sequence !== this.sequence);
      this.render();
    } else if (v[0] === 'preview-retry' || v[0] === 'preview-cancelled') {
      this.failAuxiliary(Number(v[1]), new Error('The page is being rendered again. Please retry.'));
      if (v[1] === this.inFlight) { this.inFlight = 0; this.render(); }
    } else if (v[0] === 'preview-error') {
      this.failAuxiliary(Number(v[1]), new Error(String(v[2])));
      if (v[1] === this.inFlight) { this.inFlight = 0; this.events.error(new Error(String(v[2]))); }
    } else if (v[0] === 'append-lines' && v[1] === 'out') this.events.log(v.slice(2).join('\n') + '\n');
    else if (v[0] === 'synctex' && this.inverse && typeof v[1] === 'string' && Number.isInteger(v[2])) {
      const nativeFile = path.resolve(path.dirname(this.main), v[1]);
      const file = this.physicalRoot && inside(this.physicalRoot, nativeFile) ? path.join(this.root, path.relative(this.physicalRoot, nativeFile)) : nativeFile;
      const location = { file, line: Number(v[2]), column: Number(v[3] ?? -1), word: typeof v[4] === 'string' ? v[4] : undefined };
      clearTimeout(this.inverse.timer); this.inverse.resolve(location); this.inverse = undefined;
    } else if (v[0] === 'reset-sync') { for (const [file, text] of this.opened) this.send(['open', this.enginePath(file), text]); this.barrier(); }
  }

  private acceptFrame(value: Frame) {
    const h = value.header;
    const pending = this.exports.get(h.requestId);
    if (pending) { clearTimeout(pending.timer); this.exports.delete(h.requestId); if (h.sequence === this.sequence) pending.resolve(value); else pending.reject(new Error('Source changed during page export.')); return; }
    if (h.requestId !== this.inFlight || h.sequence !== this.sequence || h.revision !== this.revision || h.page !== this.page) return;
    this.inFlight = 0; this.lastFrame = value; this.cache.set(h.page, value); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!); this.state(false); this.events.frame(value);
  }
  private render(force = false) {
    if (this.inFlight || this.acknowledged !== this.sequence || this.stopped || this.inverse || this.auxiliaryBusy) return;
    const old = this.lastFrame?.header;
    if (!force && old?.page === this.page && old.revision === this.revision && old.sequence === this.sequence) return;
    if (this.complete && this.page >= this.pages) { this.page = Math.max(0, this.pages - 1); }
    this.inFlight = ++this.requestId;
    this.send(['preview-render', this.inFlight, this.page, 1400, this.revision, this.sequence]);
  }
  showPage(page: number) { this.page = Math.max(0, Math.min(10000, Math.floor(page))); this.inFlight = 0; this.render(true); }
  async activatePage(page: number, sequence = this.sequence): Promise<FrameHeader> {
    if (sequence !== this.sequence || this.externalPending) throw new Error('The page has changed. Select the passage again.');
    this.showPage(page); const deadline = Date.now() + 15000;
    while (!this.stopped && sequence === this.sequence && Date.now() < deadline) {
      const header = this.lastFrame?.header;
      if (header?.page === page && header.sequence === this.sequence && header.revision === this.revision && !this.inFlight) return header;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('The page is updating. Please retry shortly.');
  }
  private cancelInverse() {
    if (!this.inverse) return;
    clearTimeout(this.inverse.timer); this.inverse.reject(new Error('The preview changed. Select the passage again.')); this.inverse = undefined;
  }
  private barrier() {
    this.cancelInverse(); this.cancelDestinations(); this.inFlight = 0; this.sequence++; this.state(); this.send(['preview-barrier', this.sequence]);
  }
  private cancelDestinations() { for (const pending of this.destinations.values()) { clearTimeout(pending.timer); pending.reject(new Error('The reference preview was cancelled.')); } this.destinations.clear(); }
  update(file: string, text: string) {
    if (!inside(this.root, file)) return;
    if (this.options.pdf) { this.buildPending(true); return; }
    this.opened.set(file, text); this.send(['open', this.enginePath(file), text]); this.barrier();
  }
  private enginePath(file: string) { return this.physicalRoot ? path.join(this.physicalRoot, path.relative(this.root, file)) : file; }
  closeBuffer(file: string) { if (this.opened.delete(file)) { this.send(['close', this.enginePath(file)]); this.barrier(); this.rescan(); } }
  rescan() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { this.send(['rescan']); this.barrier(); }, 80);
  }
  locate(header: FrameHeader, x: number, y: number): Promise<Location> {
    if (this.externalPending) return Promise.reject(new Error('Wait for the current PDF build to finish before annotating.'));
    if (this.options.pdf) return externalLocation(this.options.pdf, header.page, x, y, path.dirname(this.main));
    const operation = this.inverseTail.catch(() => {}).then(() => this.auxiliary(() => new Promise<Location>((resolve, reject) => {
      if (header.revision !== this.revision || header.sequence !== this.sequence || this.stopped) {
        reject(new Error('The preview is updating. Select the passage again when it settles.')); return;
      }
      const timer = setTimeout(() => { this.inverse = undefined; reject(new Error('No source location found for this selection.')); }, 2500);
      this.inverse = { resolve, reject, timer };
      this.send(['preview-inverse', header.revision, header.sequence, header.page, x, y]);
    })));
    this.inverseTail = operation;
    return operation;
  }
  async source(header: FrameHeader, rects: number[][], quote = '') {
    const deadline = Date.now() + 4000;
    // Auxiliary reruns can update a page while its annotation is being typed.
    // Wait for a current image and locate the same passage in its new geometry.
    while (true) {
      if (header.sequence !== this.sequence || header.page !== this.page || this.stopped) throw new Error('The source changed. Select the passage again.');
      const current = this.lastFrame?.header;
      if (current && current.revision === this.revision && current.sequence === this.sequence && !this.inFlight) {
        const anchored = current.revision === header.revision ? rects : reanchor(current, quote, rects);
        if (!anchored) throw new Error('The passage moved during rendering. Select it again.');
        try {
          const first = anchored[0], last = anchored[anchored.length - 1];
          const a = await this.locate(current, first[0] + Math.min(2, (first[2] - first[0]) / 2), (first[1] + first[3]) / 2);
          let b = a;
          try { b = await this.locate(current, last[2] - Math.min(2, (last[2] - last[0]) / 2), (last[1] + last[3]) / 2); } catch { /* First endpoint still anchors the note. */ }
          if (!inside(this.root, a.file)) throw new Error('This location belongs to a TeX package outside the project.');
          const text = this.opened.get(a.file) ?? await fs.readFile(a.file, 'utf8');
          const line = Math.max(1, a.line), endLine = b.file === a.file ? Math.max(line, b.line) : line;
          return { file: path.relative(this.root, a.file), line, endLine, text: text.split(/\r?\n/).slice(Math.max(0, line - 3), Math.min(endLine + 2, line + 80)).join('\n') };
        } catch (e) { if (Date.now() >= deadline || current.revision === this.revision) throw e; }
      }
      if (Date.now() >= deadline) throw new Error('The preview is still updating. Try selecting the passage again.');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  private failAuxiliary(id: number, error: Error) {
    for (const map of [this.exports, this.searches]) { const entry = map.get(id); if (entry) { clearTimeout(entry.timer); entry.reject(error); map.delete(id); } }
  }
  private auxiliary<T>(action: () => Promise<T>): Promise<T> {
    const result = this.auxiliaryTail.catch(() => {}).then(async () => {
      if (this.stopped) throw new Error('The preview is closed.');
      const deadline = Date.now() + 20000;
      while (this.acknowledged !== this.sequence || this.inFlight || this.inverse) {
        if (Date.now() > deadline || this.stopped) throw new Error('Timed out waiting for typesetting.');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      this.auxiliaryBusy = true;
      try { return await action(); } finally { this.auxiliaryBusy = false; this.render(true); }
    });
    this.auxiliaryTail = result; return result;
  }
  position(file: string, line: number): Promise<PagePoint> {
    if (this.options.pdf) return externalPosition(this.options.pdf, file, line, path.dirname(this.main));
    return this.auxiliary(() => new Promise<PagePoint>((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => { this.searches.delete(id); reject(new Error(`No rendered location found for ${path.basename(file)}:${line}.`)); }, 15000);
      this.searches.set(id, { resolve, reject, timer }); this.send(['preview-search', id, this.enginePath(file), Math.max(1, line), this.sequence]);
    }));
  }
  readPage(page: number): Promise<Frame> {
    const cached = this.cache.get(page);
    if (cached && cached.header.revision === this.revision && cached.header.sequence === this.sequence) return Promise.resolve(cached);
    return this.exportFrame(page).then(frame => { this.cache.set(page, frame); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!); return frame; });
  }
  capture(page: number, rect: number[], width = 1800): Promise<Frame> { return this.exportFrame(page, rect, width); }
  async reference(link: PdfLink) {
    if (!link.uri.startsWith('#')) throw new Error('Only internal document references have previews.');
    const sequence = this.sequence, name = link.target ? '' : link.uri.slice(1);
    let page = link.target?.page;
    if (page === undefined) page = await this.auxiliary(() => new Promise<number>((resolve, reject) => {
      if (sequence !== this.sequence) { reject(new Error('The reference changed during lookup.')); return; }
      const timer = setTimeout(() => { this.destinations.delete(name); reject(new Error('Timed out locating the reference.')); }, 15000);
      this.destinations.set(name, { resolve, reject, timer, sequence }); this.send(['preview-destination', this.revision, sequence, name]);
    }));
    if (sequence !== this.sequence) throw new Error('The reference changed during lookup.');
    const frame = await this.readPage(page);
    if (sequence !== this.sequence) throw new Error('The reference changed during lookup.');
    const destinations = frame.header.annotations?.destinations || [];
    const destination = name ? destinations.find(target => target.name === name) : destinations.filter(target => /^(cite|figure|table)[.]/i.test(target.name) && Math.hypot(target.x - link.target!.x, target.y - link.target!.y) < 6).sort((a, b) => Math.hypot(a.x - link.target!.x, a.y - link.target!.y) - Math.hypot(b.x - link.target!.x, b.y - link.target!.y))[0];
    if (name && !destination) throw new Error('The reference target has no preview coordinates.');
    return { frame, target: { page, name: destination?.name || '', x: destination?.x ?? link.target!.x, y: destination?.y ?? link.target!.y } };
  }
  private exportFrame(page: number, rect?: number[], width = 1400): Promise<Frame> {
    return this.auxiliary(() => new Promise<Frame>((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => { this.exports.delete(id); reject(new Error('Timed out exporting the paper page.')); }, 20000);
      this.exports.set(id, { resolve, reject, timer });
      this.send(rect ? ['preview-region', id, page, width, this.revision, this.sequence, ...rect] : ['preview-render', id, page, width, this.revision, this.sequence]);
    }));
  }
  async stop() {
    this.stopped = true; clearTimeout(this.syncTimer); this.cancelInverse(); this.cancelDestinations();
    for (const id of [...this.exports.keys(), ...this.searches.keys()]) this.failAuxiliary(id, new Error('The preview is closed.'));
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const child = this.child;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); child.once('close', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); });
    }
    this.reader?.close(); if (this.child) await terminate(this.child);
  }
}

export function reanchor(header: FrameHeader, quote: string, original: number[][]): number[][] | undefined {
  const chars = header.characters || [];
  const target = quote.replaceAll('\u0000', '�').replace(/\s+/g, ' ').trim();
  if (!target) return undefined;
  let text = ''; const indices: number[] = [];
  chars.forEach((c, index) => {
    const value = c[0] === 0 ? '�' : String.fromCodePoint(c[0]);
    if (/\s/.test(value)) { if (text.endsWith(' ')) return; text += ' '; indices.push(index); }
    else { text += value; for (let n = 0; n < value.length; n++) indices.push(index); }
  });
  let best = -1, distance = Infinity;
  for (let i = text.indexOf(target); i >= 0; i = text.indexOf(target, i + 1)) {
    const c = chars[indices[i]], d = Math.hypot(c[1] - original[0][0], c[2] - original[0][1]);
    if (d < distance) { best = i; distance = d; }
  }
  return best < 0 ? undefined : [chars[indices[best]].slice(1), chars[indices[best + target.length - 1]].slice(1)];
}
