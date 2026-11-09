import { execFile } from 'node:child_process';
import { localEnvironment } from './process';

export interface SetupTool { name: string; command: string; args: string[] }
export async function inspectTools(tools: SetupTool[]) {
  return Promise.all(tools.map(tool => new Promise<{ name: string; command: string; ok: boolean; detail: string }>(resolve => {
    execFile(tool.command, tool.args, { env: localEnvironment(), timeout: 5000, maxBuffer: 65536, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ name: tool.name, command: tool.command, ok: !error, detail: (error ? stderr.trim() || error.message : stdout.trim() || stderr.trim()).split(/\r?\n/).slice(0, 3).join('\n') });
    });
  })));
}
