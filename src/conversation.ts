import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Agent, Note } from './agent';
import type { Task } from './project';
import type { AgentProfile } from './agents';
import type { RunOptions } from './models';
import type { AgentActivity } from './agent-output';

export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; text: string;
  notes?: { id: string; page: number; comment: string }[];
  activities?: AgentActivity[];
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
}
export interface QueuedTurn { id: string; agent: Agent; instruction: string; notes: Note[]; assistantId: string; options?: RunOptions }
export interface Conversation {
  version: 1; id: string; agent: Agent; messages: ChatMessage[]; queue: QueuedTurn[];
  paused: boolean; draft: string; selectedNotes: string[]; selectedEdits?: string[]; task?: Task; activeTurn?: QueuedTurn; contextUpdates: string[]; agentProfile?: AgentProfile; runOptions?: RunOptions;
}
export class ConversationStore {
  value: Conversation;
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly file: string, agent: Agent = 'codex') { this.value = this.fresh(agent); }
  private fresh(agent: Agent): Conversation { return { version: 1, id: randomUUID(), agent, messages: [], queue: [], paused: false, draft: '', selectedNotes: [], contextUpdates: [] }; }
  async load() {
    try { this.value = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!Array.isArray(this.value.messages) || !Array.isArray(this.value.queue)) throw new Error('Invalid paper conversation data.');
    if (this.value.activeTurn) {
      for (const message of this.value.messages) if (message.status === 'running') message.status = 'interrupted';
      this.value.activeTurn = undefined; this.value.paused = true;
    }
    return this.value;
  }
  save() {
    const content = JSON.stringify(this.value, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true }); await fs.writeFile(this.file + '.tmp', content); await fs.rename(this.file + '.tmp', this.file);
    });
    return this.writing;
  }
  async reset(agent: Agent) {
    if (this.value.activeTurn || this.value.queue.length) throw new Error('Stop or remove queued tasks before starting a new session.');
    await this.save();
    await fs.copyFile(this.file, this.file.replace(/\.json$/, `.${this.value.id}.json`));
    this.value = this.fresh(agent); await this.save();
  }
}
