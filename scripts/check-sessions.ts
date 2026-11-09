import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createTask, refreshTask } from '../src/project';
import { runAgent, type Agent } from '../src/agent';
async function main() {
  for (const agent of (process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'claude']) as Agent[]) {
    if (!['codex', 'claude'].includes(agent)) throw new Error('Use codex or claude; set CLAUDE_CONFIG_DIR for a custom Claude profile.');
    const profile = agent === 'claude' ? { id: agent, name: 'Claude test', type: 'claude' as const, command: 'claude', claude_config_dir: process.env.CLAUDE_CONFIG_DIR } : undefined;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-session-'));
    const root = path.join(temp, 'paper'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}Test.\\end{document}');
    const task = await createTask(root, path.join(root, 'main.tex'), path.join(temp, 'storage'));
    const png = new PNG({ width: 64, height: 64 }); for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 240; png.data[i + 1] = 20; png.data[i + 2] = 20; png.data[i + 3] = 255; }
    const image = path.join(task.dir, 'vision.png'); await fs.writeFile(image, PNG.sync.write(png));
    const token = 'orchid-' + Date.now(); let run: ReturnType<typeof runAgent> | undefined;
    const timeout = setTimeout(() => { void run?.stop(); }, 180000);
    try {
      run = runAgent(agent, agent, task, [], `Look at the attached image. Write its dominant color as one English word to color.txt. Remember the token ${token} for a later turn, without writing the token to project files. Reply briefly.`, s => process.stdout.write(s), [image], undefined, profile);
      await run.done; if (!(await fs.readFile(path.join(task.proposal, 'color.txt'), 'utf8')).toLowerCase().includes('red')) throw new Error('Image understanding check failed.');
      if (!task.sessions?.[agent]) throw new Error('Session id was not captured.');
      const persisted = JSON.parse(await fs.readFile(path.join(task.dir, 'task.json'), 'utf8'));
      run = runAgent(agent, agent, persisted, [], 'Write the token I asked you to remember in our previous turn to recalled.txt. Use your conversation memory. Reply briefly.', s => process.stdout.write(s), [], undefined, profile); await run.done;
      if (!(await fs.readFile(path.join(task.proposal, 'recalled.txt'), 'utf8')).includes(token)) throw new Error('Conversation memory check failed.');
      await refreshTask(persisted, path.join(temp, 'storage'));
      run = runAgent(agent, agent, persisted, [], 'The manuscript has been applied and the workspace refreshed. Write the token from our earlier conversation to recalled-after-apply.txt. Use conversation memory; do not search other directories. Reply briefly.', s => process.stdout.write(s), [], undefined, profile); await run.done;
      if (!(await fs.readFile(path.join(task.proposal, 'recalled-after-apply.txt'), 'utf8')).includes(token)) throw new Error('Session memory was lost after the manuscript refresh.');
      console.log(`PASS: ${agent} image input, persisted session, and conversation memory.`);
    } finally { clearTimeout(timeout); await run?.stop(); await fs.rm(temp, { recursive: true, force: true }); }
  }
}
void main().catch(e => { console.error(e); process.exitCode = 1; });
