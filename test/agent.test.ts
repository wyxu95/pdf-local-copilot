import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask } from '../src/project';
import { runAgent, agentArguments } from '../src/agent';
import { launch, terminate } from '../src/process';
import { once } from 'node:events';

test('agent receives literal stdin in the task directory and can be stopped', { timeout: 10000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-agent-'));
  const root = path.join(temp, 'paper'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'main.tex'), 'Original');
  const task = await createTask(root, path.join(root, 'main.tex'), path.join(temp, 'storage'));
  const binary = path.join(temp, 'fake-agent');
  await fs.writeFile(binary, `#!/usr/bin/env node\nconst fs=require('fs');let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{fs.writeFileSync('input.json',JSON.stringify({text,args:process.argv.slice(2),cwd:process.cwd()}));process.stdout.write(JSON.stringify({type:'item.completed',item:{text:'started'}})+'\\n');setInterval(()=>{},1000);});\n`, { mode: 0o755 });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const run = runAgent('codex', binary, task, [], 'Keep this literal: $(touch should-not-exist) `echo literal`', s => { if (s.includes('started')) started(); });
  const finished = assert.rejects(run.done, /Run stopped/);
  try {
    await ready;
    const captured = JSON.parse(await fs.readFile(path.join(task.proposal, 'input.json'), 'utf8'));
    assert.equal(await fs.realpath(captured.cwd), await fs.realpath(task.proposal));
    assert.deepEqual(captured.args, agentArguments('codex')); assert.match(captured.text, /\$\(touch should-not-exist\)/);
    assert.ok(captured.text.includes('SE-paper-revising'));
    assert.ok(captured.text.includes(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', 'paper-review', 'SKILL.md')));
    await assert.rejects(fs.access(path.join(task.proposal, 'should-not-exist')));
    await run.stop(); await finished;
  } finally { await run.stop(); await fs.rm(temp, { recursive: true, force: true }); }
});
test('shutdown terminates remaining workers after their leader has already exited', { timeout: 10000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-process-')), heartbeat = path.join(temp, 'heartbeat');
  const worker = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),20);process.send('ready');`;
  const leader = launch(process.execPath, ['-e', `const worker=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','ignore','ignore','ipc']});worker.once('message',()=>{worker.disconnect();process.exit(0);});`], temp);
  try {
    await once(leader, 'close'); await fs.access(heartbeat); await terminate(leader);
    const stopped = await fs.readFile(heartbeat, 'utf8'); await new Promise(r => setTimeout(r, 150));
    assert.equal(await fs.readFile(heartbeat, 'utf8'), stopped);
  } finally { await terminate(leader); await fs.rm(temp, { recursive: true, force: true }); }
});
test('uclaude uses claude-uni and resumes its own session independently of default Claude', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-uclaude-')), root = path.join(temp, 'paper'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'main.tex'), 'Original');
  const task = await createTask(root, path.join(root, 'main.tex'), path.join(temp, 'storage')), binary = path.join(temp, 'claude');
  const primary = '11111111-1111-4111-8111-111111111111', uni = '22222222-2222-4222-8222-222222222222';
  await fs.writeFile(binary, `#!/usr/bin/env node\nconst fs=require('fs'),p=require('path');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const config=process.env.CLAUDE_CONFIG_DIR;fs.writeFileSync(p.basename(config)+'.json',JSON.stringify({config,args:process.argv.slice(2),input}));const id=config.endsWith('.claude-uni')?'${uni}':'${primary}';console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));console.log(JSON.stringify({type:'result',session_id:id,result:'OK'}));});\n`, { mode: 0o755 });
  try {
    await runAgent('claude', binary, task, [], 'Default profile', () => {}).done;
    const profile = { id: 'custom:uclaude', name: 'uclaude', type: 'claude' as const, command: binary, claude_config_dir: '~/.claude-uni' };
    await runAgent(profile.id, binary, task, [], 'Uni profile', () => {}, [], undefined, profile).done;
    await runAgent(profile.id, binary, task, [], 'Continue uni', () => {}, [], undefined, profile).done;
    assert.equal(task.sessions?.claude, primary); assert.equal(task.sessions?.['custom:uclaude'], uni);
    const capture = JSON.parse(await fs.readFile(path.join(task.proposal, '.claude-uni.json'), 'utf8'));
    assert.equal(capture.config, path.join(os.homedir(), '.claude-uni')); assert.ok(capture.args.includes('--resume')); assert.ok(capture.args.includes(uni)); assert.ok(!capture.args.includes(primary));
    assert.ok(capture.input.includes('SE-paper-revising'));
    assert.ok(capture.input.includes(path.join(os.homedir(), '.claude-uni/skills/paper-review/SKILL.md')));
    const standard = JSON.parse(await fs.readFile(path.join(task.proposal, '.claude.json'), 'utf8'));
    assert.ok(standard.input.includes(path.join(os.homedir(), '.claude/skills/paper-review/SKILL.md')));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
