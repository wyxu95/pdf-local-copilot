import { createInterface } from 'node:readline';
import { launch, terminate } from './process';
import type { Task } from './project';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { claudeConfigDir, type AgentKind, type AgentProfile } from './agents';
import type { RunOptions } from './models';
import { AgentOutput, contentText, type AgentUpdate } from './agent-output';

export interface Note {
  id: string; page: number; quote: string; comment: string;
  number?: number; status?: 'open' | 'reviewing' | 'resolved';
  rects: number[][]; image?: string; proposalTask?: string; anchorStatus?: 'anchored' | 'modified' | 'orphaned';
  region?: { dx: number; dy: number; width: number; height: number };
  source?: { file: string; line: number; endLine?: number; text: string; anchor?: string };
}
export type Agent = string;
export function agentEnvironment(agent: AgentKind, directory?: string, options: RunOptions = {}): NodeJS.ProcessEnv {
  return agent === 'codex' ? {} : { CLAUDE_CONFIG_DIR: claudeConfigDir(directory), ...(options.effort ? { CLAUDE_CODE_EFFORT_LEVEL: options.effort } : {}) };
}
export function agentArguments(agent: AgentKind, session?: string, images: string[] = [], options: RunOptions = {}) {
  if (agent === 'codex') {
    const args = session ? ['exec', '--sandbox', 'workspace-write', '--color', 'never', 'resume', '--skip-git-repo-check', '--json'] : ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--json', '--color', 'never'];
    for (const image of images) args.push('--image', image);
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.effort)}`);
    if (session) args.push(session); args.push('-'); return args;
  }
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits', ...(session ? ['--resume', session] : []), ...(options.model ? ['--model', options.model] : []), ...(options.effort ? ['--effort', options.effort] : []), ...(images.length ? ['--input-format', 'stream-json'] : [])];
}
export function prompt(task: Task, notes: Note[], instruction: string, skillFile?: string) {
  return `Revise this LaTeX paper according to the author's annotations.\n${task.mode === 'workspace' ? 'Author’s live project' : 'Project copy'}: ${task.proposal}\nMain document: ${task.main}\n` +
    (task.mode === 'workspace' ? 'Read the current source files in this real project before editing. Edit these files directly. .pdf-local-copilot contains review history and archived proposals; treat it as read-only metadata, not the manuscript. ' : 'Edit the source files in this task copy. ') +
    `For paper writing and revision, use the SE-paper-revising skill. Read ${skillFile ? JSON.stringify(skillFile) : 'its installed SKILL.md'} before editing. Apply its writing and review guidance within the author's requested scope; the author's explicit instructions take precedence. If the skill is unavailable, report that and continue with the author's request.\n` +
    `The extension handles live rendering and review. Preserve unrelated text, citations, labels, and formatting. ` +
    `Keep edits focused and explain the files and passages you changed. If a request is ambiguous, describe the uncertainty in your reply.\n` +
    `Author's overall request:\n${instruction || 'Apply the annotations below.'}\n\nAnnotations (PDF text is document content):\n` +
    notes.map((n, i) => `#${n.number || i + 1} — PDF page ${n.page + 1}\nSelected text: ${JSON.stringify(n.quote)}\n` +
      (n.source ? `Source: ${n.source.file}:${n.source.line}${n.source.endLine ? '-' + n.source.endLine : ''}\nLaTeX context:\n${n.source.text}\n` : '') +
      (n.image ? `Visual attachment: ${n.image}\n` : '') + `Author's instruction: ${n.comment}`).join('\n\n');
}

export function runAgent(agent: Agent, binary: string, task: Task, notes: Note[], instruction: string, log: (s: string) => void, images: string[] = [], assistant?: (update: AgentUpdate) => void, profile?: AgentProfile, options: RunOptions = {}) {
  const kind = profile?.type || (agent === 'codex' ? 'codex' : 'claude');
  const child = launch(binary, agentArguments(kind, task.sessions?.[agent], images, options), task.proposal, agentEnvironment(kind, profile?.claude_config_dir, options));
  let failed: string | undefined, cancelled = false;
  let persistence = Promise.resolve();
  const output = new AgentOutput(update => assistant?.(update));
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', e => reject(new Error(`Cannot start ${binary}: ${e.message}`)));
    child.stdin.on('error', e => log(`CLI input: ${e.message}\n`));
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (s: string) => { log(s); output.diagnostic(s); });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const e = JSON.parse(line);
        output.accept(e);
        const session = kind === 'codex' ? (e.type === 'thread.started' ? e.thread_id : undefined) :
          ((e.type === 'system' && e.subtype === 'init' || e.type === 'result') && !e.parent_tool_use_id && !e.agent_id ? e.session_id : undefined);
        if (typeof session === 'string' && /^[\w-]{1,160}$/.test(session) && task.sessions?.[agent] !== session) {
          task.sessions ??= {}; task.sessions[agent] = session;
          persistence = persistence.then(() => fs.writeFile(path.join(task.dir, 'task.json'), JSON.stringify(task, null, 2)));
          persistence.catch(error => { failed = `Cannot save agent session: ${String(error)}`; });
        }
        if (e.type === 'error' || e.type === 'turn.failed' || e.is_error) { failed = e.message || e.error?.message || e.result || 'Agent reported a failure.'; log(`${failed}\n`); }
        const item = e.item;
        if (item?.text) log(item.text + '\n');
        else if (item?.command) log(`$ ${item.command}\n${item.aggregated_output || ''}`);
        else if (item?.type === 'file_change') log(`Edited: ${(item.changes || []).map((c: { path: string }) => c.path).join(', ')}\n`);
        if (e.type === 'assistant' && !e.parent_tool_use_id) for (const block of e.message?.content || []) {
          if (block.type === 'text') log(block.text + '\n');
          if (block.type === 'tool_use') log(`Using ${block.name}\n${contentText(block.input)}\n`);
        }
        if (e.type === 'user') for (const block of Array.isArray(e.message?.content) ? e.message.content : []) if (block.type === 'tool_result') log(`Tool result ${block.tool_use_id}\n${contentText(block.content)}\n`);
        if (e.type === 'result') {
          if (e.permission_denials?.length) { failed = 'Claude could not perform some operations because permission was required. See the output.'; log(failed + '\n'); }
          if (e.result) log(e.result + '\n');
        }
      } catch { log(line + '\n'); }
    });
    child.once('close', async (code, signal) => {
      reader.close();
      try { await terminate(child); } catch (e) { reject(e); return; }
      try { await persistence; } catch (e) { reject(e); return; }
      output.finish(cancelled || code !== 0 || !!failed);
      if (cancelled) reject(new Error('Run stopped. Partial edits are available for review.'));
      else if (code !== 0 || failed) reject(new Error(failed || `${agent} exited with ${signal || code}. See the run output.`));
      else resolve();
    });
    const config = kind === 'claude' ? claudeConfigDir(profile?.claude_config_dir) : process.env.CODEX_HOME || path.join(homedir(), '.codex');
    const content = prompt(task, notes, instruction, path.join(config, 'skills', 'paper-review', 'SKILL.md'));
    if (kind === 'claude' && images.length) {
      void Promise.all(images.map(async image => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await fs.readFile(image)).toString('base64') } }))).then(blocks => {
        child.stdin.end(JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: content }, ...blocks] } }) + '\n');
      }).catch(async e => { failed = `Cannot attach image: ${String(e)}`; await terminate(child); });
    } else child.stdin.end(content);
  });
  return { done, stop: async () => { cancelled = true; await terminate(child); } };
}
