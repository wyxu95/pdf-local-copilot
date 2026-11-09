import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { modelCatalog, runOptions } from '../src/models';
import { agentArguments, agentEnvironment } from '../src/agent';

test('model and effort overrides reach both new and resumed CLI sessions', () => {
  for (const session of [undefined, '11111111-1111-4111-8111-111111111111']) {
    const options = { model: 'selected-model', effort: 'high' };
    for (const kind of ['codex', 'claude'] as const) {
      const args = agentArguments(kind, session, [], options);
      assert.equal(args[args.indexOf('--model') + 1], options.model);
      if (kind === 'codex') assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort="high"');
      else { assert.equal(args[args.indexOf('--effort') + 1], 'high'); assert.equal(agentEnvironment(kind, '~/.claude-uni', options).CLAUDE_CODE_EFFORT_LEVEL, 'high'); }
      if (session) assert.ok(args.includes(session));
    }
  }
  assert.ok(!agentArguments('claude').includes('--model')); assert.ok(!agentArguments('codex').includes('-c'));
  assert.throws(() => runOptions({ effort: 'ultra' }, 'claude'), /Invalid/);
  assert.throws(() => runOptions({ model: 'bad\nmodel' }, 'codex'), /Invalid/);
});
test('Claude catalogs read each named profile independently', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-models-'));
  try {
    for (const [name, model] of [['primary', 'primary-model'], ['uni', 'university-model']]) {
      const dir = path.join(temp, name); await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ model, availableModels: [model] }));
      const catalog = await modelCatalog({ id: name, name, type: 'claude', command: 'claude', claude_config_dir: dir });
      assert.deepEqual(catalog.models.map(m => m.value), [model]); assert.ok(catalog.efforts.includes('xhigh'));
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
