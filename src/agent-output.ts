export interface AgentActivity {
  id: string; title: string; input?: string; output?: string; status: 'running' | 'completed' | 'failed';
}
export interface AgentUpdate { text: string; activities: AgentActivity[] }
export const contentText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block?.text || '').filter(Boolean).join('\n') : content == null ? '' : JSON.stringify(content, null, 2);
const display = (value: unknown) => {
  const text = contentText(value); return text.length > 32000 ? text.slice(0, 16000) + '\n… (Full output is available in Logs.) …\n' + text.slice(-16000) : text;
};

export class AgentOutput {
  private texts = new Map<string, string>();
  private activities = new Map<string, AgentActivity>();
  private message = ''; private sequence = 0;
  private toolBlocks = new Map<number, { id: string; json: string }>();
  constructor(private changed: (update: AgentUpdate) => void) {}
  private emit() { this.changed({ text: [...this.texts.values()].filter(Boolean).join('\n\n'), activities: [...this.activities.values()].map(activity => ({ ...activity })) }); }
  private tool(id: string, name: string, input?: unknown) {
    const old = this.activities.get(id);
    this.activities.set(id, { id, title: name, status: old?.status || 'running', input: input ? display(input) : old?.input, output: old?.output });
  }
  accept(e: any) {
    if (e.type === 'stream_event' && !e.parent_tool_use_id) {
      const event = e.event || {}, index = event.index || 0;
      if (event.type === 'message_start') { this.message = event.message?.id || `message-${++this.sequence}`; this.toolBlocks.clear(); return; }
      const key = `${this.message}:${index}`;
      if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        if (block.type === 'text') this.texts.set(key, block.text || '');
        else if (block.type === 'tool_use') { this.toolBlocks.set(index, { id: block.id, json: '' }); this.tool(block.id, block.name, block.input); }
        else return;
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') this.texts.set(key, (this.texts.get(key) || '') + event.delta.text);
      else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') { const tool = this.toolBlocks.get(index); if (tool) tool.json += event.delta.partial_json; return; }
      else if (event.type === 'content_block_stop') {
        const tool = this.toolBlocks.get(index); if (!tool?.json) return;
        try { this.activities.get(tool.id)!.input = display(JSON.parse(tool.json)); } catch { return; }
      } else return;
      this.emit(); return;
    }
    if (e.type === 'assistant' && !e.parent_tool_use_id) {
      const id = e.message?.id || this.message || `message-${++this.sequence}`;
      const content = e.message?.content;
      if (typeof content === 'string') this.texts.set(`${id}:0`, content);
      else (content || []).forEach((block: any, index: number) => {
        if (block.type === 'text') {
          const streamed = [...this.texts].find(([key, text]) => key.startsWith(`${id}:`) && text === block.text)?.[0];
          this.texts.set(streamed || `${id}:${index}`, block.text);
        }
        if (block.type === 'tool_use') this.tool(block.id, block.name, block.input);
      });
    } else if (e.type === 'user') {
      for (const block of Array.isArray(e.message?.content) ? e.message.content : []) if (block.type === 'tool_result') {
        const old = this.activities.get(block.tool_use_id);
        this.activities.set(block.tool_use_id, { id: block.tool_use_id, title: old?.title || 'Tool Output', input: old?.input, status: block.is_error ? 'failed' : 'completed', output: display(block.content) });
      }
    } else if (e.type === 'tool_progress') {
      if (!this.activities.has(e.tool_use_id)) this.tool(e.tool_use_id, e.tool_name || 'Run Tool');
    } else if (e.type === 'system' && e.subtype === 'init') {
      this.activities.set('connection', { id: 'connection', title: e.model ? `Connected · ${e.model}` : 'Agent session connected', status: 'completed' });
    } else if (/^item\.(started|updated|completed)$/.test(e.type || '')) {
      const item = e.item || {}, id = item.id || `item-${++this.sequence}`;
      const status = item.status === 'failed' || item.exit_code ? 'failed' : e.type === 'item.completed' ? 'completed' : 'running';
      if (item.type === 'agent_message') this.texts.set(id, item.text || '');
      else if (item.type === 'command_execution') this.activities.set(id, { id, title: 'Run Command', input: item.command, output: display(item.aggregated_output), status });
      else if (item.type === 'file_change') this.activities.set(id, { id, title: 'Edit Files', input: (item.changes || []).map((change: any) => `${change.kind || 'update'} · ${change.path}`).join('\n'), status });
      else if (item.type === 'mcp_tool_call') this.activities.set(id, { id, title: `${item.server || 'MCP'} · ${item.tool || 'Tool'}`, input: display(item.arguments), output: display(item.result?.content || item.error), status });
      else if (item.type === 'web_search') this.activities.set(id, { id, title: 'Search Web', input: item.query, status });
      else if (item.type === 'reasoning' && item.text) this.activities.set(id, { id, title: 'Reasoning Progress', output: display(item.text), status });
      else return;
    } else if (e.type === 'result' && e.result) {
      const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();
      if (!normalized([...this.texts.values()].join('\n')).endsWith(normalized(e.result))) this.texts.set(`result-${++this.sequence}`, e.result);
    } else return;
    this.emit();
  }
  diagnostic(text: string) {
    const old = this.activities.get('diagnostic');
    this.activities.set('diagnostic', { id: 'diagnostic', title: 'CLI Logs', output: display((old?.output || '') + text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')), status: 'running' }); this.emit();
  }
  finish(failed: boolean) { for (const activity of this.activities.values()) if (activity.status === 'running') activity.status = failed ? 'failed' : 'completed'; this.emit(); }
}
