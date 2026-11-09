import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

export function localEnvironment() {
  const extra = [path.join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin'];
  return { ...process.env, PATH: [...new Set([...(process.env.PATH || '').split(path.delimiter), ...extra])].join(path.delimiter) };
}
const shutdowns = new WeakMap<ChildProcess, Promise<void>>();
export function terminate(child: ChildProcess): Promise<void> {
  const existing = shutdowns.get(child); if (existing) return existing;
  const result = stopGroup(child); shutdowns.set(child, result); return result;
}
async function stopGroup(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { const task = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); task.once('close', () => resolve()); task.once('error', () => resolve()); });
    return;
  }
  let signalled = false;
  const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ESRCH' || (e as NodeJS.ErrnoException).code === 'EPERM' && (signalled || child.exitCode !== null || child.signalCode !== null);
  const exists = () => { try { process.kill(-child.pid!, 0); return true; } catch (e) { if (gone(e)) return false; throw e; } };
  const signal = (value: NodeJS.Signals) => { try { process.kill(-child.pid!, value); signalled = true; } catch (e) { if (!gone(e)) throw e; } };
  if (!exists()) return;
  signal('SIGTERM');
  const deadline = Date.now() + 2000;
  while (exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  if (exists()) signal('SIGKILL');
}
export function launch(binary: string, args: string[], cwd: string, overrides: NodeJS.ProcessEnv = {}) {
  return spawn(binary, args, { cwd, env: { ...localEnvironment(), ...overrides }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
}
