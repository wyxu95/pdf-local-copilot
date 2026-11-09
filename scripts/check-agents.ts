import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask } from '../src/project';
import { runAgent, type Agent } from '../src/agent';
const agents = process.argv.slice(2) as Agent[];
if (!agents.length || agents.some(a => !['codex', 'claude'].includes(a))) throw new Error('Usage: npx tsx scripts/check-agents.ts codex [claude]');
async function main() {
for (const agent of agents) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `pdf-copilot-${agent}-`));
  const root = path.join(temp, 'paper'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nThe result is very very good.\n\\end{document}\n');
  const task = await createTask(root, path.join(root, 'main.tex'), path.join(temp, 'storage'));
  const run = runAgent(agent, agent, task, [], 'In main.tex replace exactly "The result is very very good." with "The result is promising.". Make only this edit. Reply briefly.', s => process.stdout.write(s));
  const timer = setTimeout(() => { void run.stop(); }, 120000);
  try {
    await run.done;
    const result = await fs.readFile(path.join(task.proposal, 'main.tex'), 'utf8');
    if (!result.includes('The result is promising.')) throw new Error(`${agent} did not make the expected edit.`);
    const original = await fs.readFile(path.join(root, 'main.tex'), 'utf8');
    if (!original.includes('very very')) throw new Error('The original manuscript changed.');
    console.log(`\nPASS: ${agent} edited the task copy and preserved the original.`);
  } finally { clearTimeout(timer); await run.stop(); await fs.rm(temp, { recursive: true, force: true }); }
}
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
