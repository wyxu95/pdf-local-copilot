import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { WorkingTree } from '../src/project';
import { ConversationStore } from '../src/conversation';

test('overlapping new-session requests end the old review and reset the conversation once', { timeout: 10000 }, async () => {
  const bundle = await build({ entryPoints: ['src/paper.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['vscode'] });
  const module = { exports: {} as any }, require = createRequire(path.resolve('package.json'));
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    (name: string) => name === 'vscode' ? { workspace: { textDocuments: [] }, window: { tabGroups: { all: [] } } } : require(name), module, module.exports);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-session-start-')), main = path.join(root, 'main.tex');
  await fs.writeFile(main, 'Original manuscript');
  const tree = await WorkingTree.create(root, main), store = new ConversationStore(path.join(root, '.pdf-local-copilot', 'chat.json'), 'claude');
  const oldId = store.value.id; store.value.task = tree.task; await store.save();
  let release!: () => void, captures = 0, resets = 0;
  const delayedCapture = new Promise<void>(resolve => { release = resolve; }), capture = tree.capture.bind(tree), reset = store.reset.bind(store);
  tree.capture = () => ++captures === 2 ? delayedCapture : capture();
  store.reset = async agent => { resets++; await reset(agent); };
  const paper = Object.assign(Object.create(module.exports.Paper.prototype), {
    root, main, task: tree.task, workingTree: tree, review: { version: 1, files: [] }, conversation: store,
    selectedNotes: new Set(), selectedEdits: new Set(), decisions: Promise.resolve(),
    context: { workspaceState: { update: async () => {} } }, ui: { refresh: () => {} },
    both: () => {}, saveConversation: () => store.save(), refreshAnchors: async () => {},
    agentProfiles: () => [{ id: 'claude' }]
  });
  const first = paper.newSession(), second = paper.newSession();
  const completed = Promise.allSettled([first, second]);
  try {
    await first; release();
    const results = await completed;
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    assert.equal(resets, 1); assert.equal(captures, 1);
    assert.equal(paper.task, undefined); assert.notEqual(store.value.id, oldId);
    assert.equal(JSON.parse(await fs.readFile(path.join(tree.task.dir, 'task.json'), 'utf8')).ended, true);
    assert.equal(JSON.parse(await fs.readFile(store.file.replace(/\.json$/, `.${oldId}.json`), 'utf8')).id, oldId);
    const currentId = store.value.id;
    await paper.newSession();
    assert.equal(resets, 2); assert.notEqual(store.value.id, currentId);
  } finally { release(); await completed; await fs.rm(root, { recursive: true, force: true }); }
});
