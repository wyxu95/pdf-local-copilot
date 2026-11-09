#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', s => { prompt += s; });
process.stdin.on('end', () => {
  if (!prompt.includes('Author')) throw new Error('Missing author prompt');
  const file = 'main.tex';
  const before = fs.readFileSync(file, 'utf8');
  const resumed = process.argv.includes('resume');
  if (!resumed && process.argv.includes('--image')) { const image = process.argv[process.argv.indexOf('--image') + 1]; if (fs.readFileSync(image).subarray(1, 4).toString() !== 'PNG') throw new Error('Missing PDF image attachment'); }
  const testData = path.resolve('.pdf-local-copilot/test'); fs.mkdirSync(testData, { recursive: true });
  fs.appendFileSync(path.join(testData, 'fake-calls.jsonl'), JSON.stringify({ resumed, cwd: process.cwd(), args: process.argv.slice(2), prompt, before }) + '\n');
  fs.writeFileSync(file, resumed ? before : before.replace('Our approach makes the writing process more better and very efficient.', 'Our approach supports local revisions.'));
  if (resumed && prompt.includes('Keep the current edits and continue in this session.')) {
    fs.writeFileSync(file, before.replace('Our approach supports local revisions.', 'Our approach improves the efficiency of scientific writing.').replace('The author can compare versions,', 'The author can inspect proposed versions,'));
    fs.writeFileSync('refs.bib', fs.readFileSync('refs.bib', 'utf8').replace('IntermediateReferenceTitle', 'RevisedReferenceTitle').replace('2028', '2035'));
    for (const [name, old, next] of [['helper.js', 'intermediateCodeValue', 'newCodeValue'], ['writingplan.md', 'IntermediatePlanDescription', 'UpdatedPlanDescription']]) fs.writeFileSync(name, fs.readFileSync(name, 'utf8').replace(old, next));
  }
  if (resumed && prompt.includes('Direct session change:')) fs.writeFileSync(file, before.replace('An Example Equation', 'An Improved Equation'));
  if (!resumed && fs.existsSync('refs.bib')) fs.writeFileSync('refs.bib', fs.readFileSync('refs.bib', 'utf8').replace('OldReferenceTitle', 'IntermediateReferenceTitle').replace('2021', '2028'));
  if (!resumed) for (const [file, old, next] of [['helper.js', 'oldCodeValue', 'intermediateCodeValue'], ['writingplan.md', 'OldPlanDescription', 'IntermediatePlanDescription']]) if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(old, next));
  process.stdout.write('{"type":"thread.started","thread_id":"11111111-1111-4111-8111-111111111111"}\n');
  const emit = (type, item) => process.stdout.write(JSON.stringify({ type, item }) + '\n');
  const finish = () => {
    emit('item.completed', { id: 'read', type: 'command_execution', command: 'cat main.tex', aggregated_output: before.slice(0, 250), exit_code: 0 });
    emit('item.completed', { id: 'answer', type: 'agent_message', text: 'Revised the selected sentence in main.tex.' });
    process.stdout.write('{"type":"turn.completed"}\n');
  };
  if (!resumed) {
    emit('item.started', { id: 'read', type: 'command_execution', command: 'cat main.tex' });
    emit('item.updated', { id: 'answer', type: 'agent_message', text: 'Reading main.tex' });
    setTimeout(() => { emit('item.updated', { id: 'read', type: 'command_execution', command: 'cat main.tex', aggregated_output: before.slice(0, 250) }); emit('item.updated', { id: 'answer', type: 'agent_message', text: 'Reading main.tex and preparing edits.' }); }, 200);
    const gate = path.join(testData, 'release-agent');
    const timer = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(timer); finish(); } }, 50);
    setTimeout(() => { clearInterval(timer); finish(); }, 90000).unref();
  } else finish();
});
