import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore } from '../src/conversation';
import { createTask, refreshTask } from '../src/project';
test('refreshing the applied manuscript keeps the working directory and CLI session identity', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-context-')), root = path.join(temp, 'paper'), storage = path.join(temp, 'storage'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.tex'), 'Original');
  try {
    const task = await createTask(root, path.join(root, 'main.tex'), storage), directory = task.proposal;
    task.sessions = { codex: '11111111-1111-4111-8111-111111111111' };
    await fs.writeFile(path.join(task.dir, 'review.json'), '{"accepted":true}');
    await fs.writeFile(path.join(root, 'main.tex'), 'Applied manuscript');
    await refreshTask(task, storage);
    assert.equal(task.proposal, directory); assert.equal(task.sessions.codex, '11111111-1111-4111-8111-111111111111');
    assert.equal(await fs.readFile(path.join(directory, 'main.tex'), 'utf8'), 'Applied manuscript');
    assert.ok(await fs.readFile(path.join(task.dir, 'rounds/1.json'), 'utf8'));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
test('conversation reload preserves queued tasks and only explicit reset changes its identity', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-chat-')), file = path.join(temp, 'chat.json');
  try {
    const store = new ConversationStore(file), id = store.value.id;
    store.value.queue.push({ id: 'a', assistantId: 'b', agent: 'codex', instruction: 'First', notes: [], options: { model: 'queued-model', effort: 'low' } });
    store.value.runOptions = { model: 'next-model', effort: 'high' }; await store.save();
    const loaded = new ConversationStore(file); await loaded.load(); assert.equal(loaded.value.id, id); assert.equal(loaded.value.queue[0].instruction, 'First');
    assert.deepEqual(loaded.value.queue[0].options, { model: 'queued-model', effort: 'low' }); assert.equal(loaded.value.runOptions?.model, 'next-model');
    await assert.rejects(loaded.reset('codex'), /排队任务/); loaded.value.queue = []; await loaded.save(); assert.equal(loaded.value.id, id);
    await loaded.reset('codex'); assert.notEqual(loaded.value.id, id);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
