import path from 'node:path';
import { homedir } from 'node:os';
export type AgentKind = 'codex' | 'claude';
export interface AgentProfile { id: string; name: string; type: AgentKind; command: string; claude_config_dir?: string }
export interface CustomAgent { id?: string; name: string; type: AgentKind; command?: string; claude_config_dir?: string }
export function claudeConfigDir(value = '~/.claude') {
  const home = homedir(), expanded = (value.trim() || '~/.claude').replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(home, expanded);
}
export function configuredAgents(custom: CustomAgent[] = [], commands = { codex: 'codex', claude: 'claude' }): AgentProfile[] {
  const result: AgentProfile[] = [{ id: 'codex', name: 'Codex', type: 'codex', command: commands.codex }, { id: 'claude', name: 'Claude Code', type: 'claude', command: commands.claude, claude_config_dir: claudeConfigDir() }];
  for (const item of custom) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || !['codex', 'claude'].includes(item.type)) throw new Error('代理配置需要 name 和 type（codex 或 claude）。');
    const name = item.name.trim(), id = `custom:${item.id || name}`;
    if (result.some(profile => profile.id === id || profile.name.toLowerCase() === name.toLowerCase())) throw new Error(`代理名称或标识重复：${name}`);
    result.push({ id, name, type: item.type, command: item.command || commands[item.type], ...(item.type === 'claude' ? { claude_config_dir: claudeConfigDir(item.claude_config_dir) } : {}) });
  }
  return result;
}
