import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentKind, AgentProfile } from './agents';

export interface RunOptions { model?: string; effort?: string }
export interface ModelOption { value: string; label: string; efforts: string[] }
export interface ModelCatalog { models: ModelOption[]; efforts: string[] }
export const effortLevels = (kind: AgentKind) => kind === 'codex' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max'];
export function runOptions(value: unknown, kind: AgentKind): RunOptions {
  const { model = '', effort = '' } = (value || {}) as RunOptions;
  if (typeof model !== 'string' || model.length > 200 || /[\u0000-\u001f]/.test(model) || typeof effort !== 'string' || effort && ![...effortLevels(kind), ...(kind === 'codex' ? ['none', 'minimal'] : [])].includes(effort)) throw new Error('模型或思考强度无效。');
  return { model: model.trim(), effort };
}
export async function modelCatalog(profile: AgentProfile): Promise<ModelCatalog> {
  const efforts = effortLevels(profile.type), models: ModelOption[] = [];
  if (profile.type === 'codex') {
    try {
      const cache = JSON.parse(await fs.readFile(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
      for (const model of cache.models || []) if (model.visibility === 'list' && typeof model.slug === 'string') models.push({ value: model.slug, label: model.display_name || model.slug, efforts: model.supported_reasoning_levels?.map((level: { effort: string }) => level.effort) || efforts });
    } catch { /* A custom model can also be entered before the CLI caches its catalog. */ }
  } else {
    let settings: { model?: string; availableModels?: string[]; modelSettings?: Record<string, unknown> } = {};
    try { settings = JSON.parse(await fs.readFile(path.join(profile.claude_config_dir!, 'settings.json'), 'utf8')); } catch {}
    const names = settings.availableModels || ['opus', 'sonnet', 'haiku', 'fable', 'opus[1m]', 'sonnet[1m]', ...Object.keys(settings.modelSettings || {})];
    for (const value of new Set([...(settings.model ? [settings.model] : []), ...names])) models.push({ value, label: value, efforts });
  }
  return { models, efforts };
}
