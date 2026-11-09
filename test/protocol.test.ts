import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFrames } from '../src/protocol';

test('binary framing survives every byte boundary, embedded newlines, and Unicode notifications', () => {
  const body = Buffer.from([137, 80, 78, 71, 10, 0, 255, 10]);
  const header = { requestId: 1, revision: 2, sequence: 3, page: 0, bounds: [0, 0, 612, 792], width: 100, height: 130, mime: 'image/png', byteLength: body.length, characters: [[0x1f600, 0, 0, 10, 10]] };
  const wire = Buffer.concat([Buffer.from(JSON.stringify(['append-lines', 'out', '编译中 😀']) + '\n' + JSON.stringify(['preview-image', header]) + '\n'), body, Buffer.from('["flush"]\n')]);
  for (let split = 0; split <= wire.length; split++) {
    const input = new PassThrough(), notifications: unknown[] = [], images: unknown[] = [], errors: Error[] = [];
    readFrames(input, m => notifications.push(m), f => images.push(f), e => errors.push(e));
    input.write(wire.subarray(0, split)); input.end(wire.subarray(split));
    assert.deepEqual(errors, []); assert.deepEqual(notifications, [['append-lines', 'out', '编译中 😀'], ['flush']]);
    assert.equal(images.length, 1); assert.deepEqual((images[0] as { bytes: Buffer }).bytes, body);
  }
});
test('rejects oversized image declarations before allocating the body', () => {
  const input = new PassThrough(), errors: Error[] = [];
  readFrames(input, () => {}, () => assert.fail('invalid frame accepted'), e => errors.push(e));
  input.end(JSON.stringify(['preview-image', { requestId: 1, revision: 0, sequence: 0, page: 0, bounds: [0, 0, 1, 1], width: 1, height: 1, byteLength: 1000000000, mime: 'image/png' }]) + '\n');
  assert.equal(errors.length, 1);
});
test('partial binary frames fail on EOF', async () => {
  const input = new PassThrough(), failure = new Promise<Error>(resolve => readFrames(input, () => {}, () => assert.fail(), resolve));
  input.end('["preview-image",{"requestId":1,"revision":0,"sequence":0,"page":0,"bounds":[0,0,1,1],"width":1,"height":1,"byteLength":20,"mime":"image/png"}]\nabc');
  assert.match((await failure).message, /during a frame/);
});
