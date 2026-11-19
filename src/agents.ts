import path from 'node:path';
import { homedir } from 'node:os';
import type { WorkspaceConfiguration } from 'vscode';
export type AgentKind = 'codex' | 'claude';
interface AgentDirectories { claude_config_dir?: string; codex_home?: string }
export interface AgentProfile extends AgentDirectories { id: string; name: string; type: AgentKind; command: string }
export interface CustomAgent extends AgentDirectories { id?: string; name: string; type: AgentKind; command?: string }

function expandHome(value: string) {
  return value.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
}
export function claudeConfigDir(value = process.env.CLAUDE_CONFIG_DIR || '~/.claude') {
  return path.resolve(homedir(), expandHome(value.trim() || '~/.claude'));
}
export function codexConfigDir(value = process.env.CODEX_HOME || '~/.codex') {
  return path.resolve(homedir(), expandHome(value.trim() || '~/.codex'));
}
function explicitDirectories(type: AgentKind, item: AgentDirectories): AgentDirectories {
  if (type === 'claude' && item.claude_config_dir?.trim()) return { claude_config_dir: claudeConfigDir(item.claude_config_dir) };
  if (type === 'codex' && item.codex_home?.trim()) return { codex_home: codexConfigDir(item.codex_home) };
  return {};
}
export function configuredAgents(custom: CustomAgent[] = [], commands = { codex: 'codex', claude: 'claude' }, directories: AgentDirectories = {}): AgentProfile[] {
  const builtInCommand = (type: AgentKind) => expandHome(commands[type].trim() || type);
  const result: AgentProfile[] = [
    { id: 'codex', name: 'Codex', type: 'codex', command: builtInCommand('codex'), ...explicitDirectories('codex', directories) },
    { id: 'claude', name: 'Claude Code', type: 'claude', command: builtInCommand('claude'), ...explicitDirectories('claude', directories) }
  ];
  for (const item of custom) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || !['codex', 'claude'].includes(item.type)) throw new Error('Agent profiles require name and type (codex or claude).');
    const name = item.name.trim(), id = `custom:${item.id || name}`;
    if (result.some(profile => profile.id === id || profile.name.toLowerCase() === name.toLowerCase())) throw new Error(`Duplicate agent name or ID: ${name}`);
    result.push({ id, name, type: item.type, command: expandHome(item.command?.trim() || builtInCommand(item.type)), ...explicitDirectories(item.type, item) });
  }
  return result;
}

export function agentsFromSettings(config: Pick<WorkspaceConfiguration, 'get'>): AgentProfile[] {
  return configuredAgents(config.get<CustomAgent[]>('agents', []),
    { codex: config.get('codexPath', 'codex'), claude: config.get('claudePath', 'claude') },
    { codex_home: config.get('codexConfigDir', ''), claude_config_dir: config.get('claudeConfigDir', '') });
}
