import { createHash } from 'node:crypto';
import type { Frame } from './protocol';

export class FrameDelivery {
  private sent = new Map<string, { session: number; imageId: string }>();
  constructor(readonly viewId: string) {}
  forget(side: string, page: number) { this.sent.delete(`${side}:${page}`); }
  encode(type: 'frame' | 'pageFrame', side: 'before' | 'after', session: number, frame: Frame, forceImage = false) {
    const imageId = createHash('sha256').update(frame.header.mime).update(frame.bytes).digest('hex');
    const { bounds, width, height, characters, annotations } = frame.header;
    const layoutId = createHash('sha256').update(JSON.stringify([bounds, width, height, characters, annotations])).digest('hex');
    const key = `${side}:${frame.header.page}`, previous = this.sent.get(key);
    const reuse = !forceImage && previous?.session === session && previous.imageId === imageId;
    this.sent.delete(key); this.sent.set(key, { session, imageId });
    while (this.sent.size > 16) this.sent.delete(this.sent.keys().next().value!);
    return { type, side, session, viewId: this.viewId, imageId, layoutId, header: frame.header, ...(!reuse ? { data: frame.bytes.toString('base64') } : {}) };
  }
}
