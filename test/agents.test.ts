import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { configuredAgents, claudeConfigDir } from '../src/agents';
test('named Claude profiles use arbitrary independent directories and inherit the configured binary', () => {
  const profiles = configuredAgents([{ name: 'uclaude', type: 'claude', claude_config_dir: '~/.claude-uni' }, { name: 'lab-reviewer', type: 'claude', claude_config_dir: '/tmp/lab-claude' }], { codex: '/bin/codex', claude: '/bin/claude' });
  assert.equal(profiles.length, 4); assert.equal(profiles[2].id, 'custom:uclaude'); assert.equal(profiles[2].command, '/bin/claude');
  assert.equal(profiles[2].claude_config_dir, path.join(os.homedir(), '.claude-uni')); assert.equal(profiles[3].claude_config_dir, '/tmp/lab-claude');
  assert.notEqual(profiles[1].claude_config_dir, profiles[2].claude_config_dir);
});
test('configuration directories expand home syntax without shell evaluation', () => {
  assert.equal(claudeConfigDir('$HOME/.claude-uni'), path.join(os.homedir(), '.claude-uni'));
  assert.equal(claudeConfigDir('${HOME}/other-profile'), path.join(os.homedir(), 'other-profile'));
  assert.throws(() => configuredAgents([{ name: 'Claude Code', type: 'claude' }]), /Duplicate/);
});
