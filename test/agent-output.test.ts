import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOutput, type AgentUpdate } from '../src/agent-output';

test('Claude text streams before completion and full assistant/result events do not duplicate it', () => {
  let latest!: AgentUpdate; const output = new AgentOutput(update => { latest = update; });
  const event = (event: unknown) => output.accept({ type: 'stream_event', event });
  event({ type: 'message_start', message: { id: 'message-one' } });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading ' } });
  assert.equal(latest.text, 'Reading ');
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the plan.' } });
  output.accept({ type: 'assistant', message: { id: 'message-one', content: [{ type: 'text', text: 'Reading the plan.' }] } });
  output.accept({ type: 'result', result: 'Reading the plan.' });
  assert.equal(latest.text, 'Reading the plan.');
  event({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'Plan loaded.' } });
  output.accept({ type: 'assistant', message: { id: 'message-one', content: [{ type: 'text', text: 'Plan loaded.' }] } });
  output.accept({ type: 'result', result: 'Reading the plan.\nPlan loaded.' });
  assert.equal(latest.text, 'Reading the plan.\n\nPlan loaded.');
});
test('Claude tool input, results and failures remain visible across streaming and full messages', () => {
  let latest!: AgentUpdate; const output = new AgentOutput(update => { latest = update; });
  output.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'one' } } });
  output.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'read', name: 'Read', input: {} } } });
  output.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"writingplan.md"}' } } });
  output.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
  assert.match(latest.activities[0].input!, /writingplan.md/); assert.equal(latest.activities[0].status, 'running');
  output.accept({ type: 'assistant', message: { id: 'one', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'writingplan.md' } }] } });
  output.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: [{ type: 'text', text: 'Plan contents' }], is_error: true }] } });
  assert.equal(latest.activities.length, 1); assert.equal(latest.activities[0].output, 'Plan contents'); assert.equal(latest.activities[0].status, 'failed');
});
test('Codex messages and commands update in place and diagnostics are available while running', () => {
  let latest!: AgentUpdate; const output = new AgentOutput(update => { latest = update; });
  output.accept({ type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'cat main.tex' } });
  assert.equal(latest.activities[0].status, 'running');
  output.accept({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: 'Reading' } });
  assert.equal(latest.text, 'Reading');
  output.accept({ type: 'item.completed', item: { id: 'command', type: 'command_execution', command: 'cat main.tex', aggregated_output: 'Source contents', exit_code: 0 } });
  output.accept({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Done' } });
  output.diagnostic('Warning from CLI'); output.finish(false);
  assert.equal(latest.text, 'Done'); assert.equal(latest.activities[0].output, 'Source contents'); assert.equal(latest.activities[0].status, 'completed'); assert.match(latest.activities[1].output!, /Warning/);
});
