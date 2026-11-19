import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProfile } from './agents';
import { agentEnvironment } from './agent';
import { launch, localEnvironment, terminate } from './process';

export function claudeAuthStatus(profile: AgentProfile, cwd: string) {
  const env = { ...localEnvironment(), ...agentEnvironment('claude', profile.claude_config_dir) };
  return new Promise<{ loggedIn: boolean; authMethod?: string; configDirectory?: string }>((resolve, reject) => {
    execFile(profile.command, ['auth', 'status', '--json'], { cwd, env, timeout: 10000 }, (_error, stdout) => {
      try {
        const status = JSON.parse(stdout);
        if (typeof status?.loggedIn === 'boolean') {
          resolve({ loggedIn: status.loggedIn, authMethod: status.authMethod, configDirectory: status.configDirectory });
          return;
        }
      } catch {}
      reject(new Error('Claude Code could not report its authentication status.'));
    });
  });
}

const oauthHosts = new Set(['claude.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com']);

export function startClaudeLogin(profile: AgentProfile, cwd: string, authorization: (url: URL) => void) {
  const child = launch(profile.command, ['auth', 'login'], cwd, {
    ...agentEnvironment('claude', profile.claude_config_dir), BROWSER: 'false'
  });
  const readOutput = (input: NodeJS.ReadableStream) => createInterface({ input }).on('line', line => {
    for (const candidate of line.matchAll(/https:\/\/[^\s\u0000-\u001f<>"\u007f]+/g)) {
      try {
        const url = new URL(candidate[0]);
        if (oauthHosts.has(url.host) && !url.username && !url.password && /^(?:\/cai)?\/oauth\/authorize\/?$/.test(url.pathname)) authorization(url);
      } catch {}
    }
  });
  const stdout = readOutput(child.stdout), stderr = readOutput(child.stderr);
  child.stdin.on('error', () => { /* Closing the CLI can interrupt a pending write. */ });
  const done = new Promise<boolean>(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => { stdout.close(); stderr.close(); resolve(code === 0); });
  });
  return { done, sendCode: (code: string) => child.stdin.end(code + '\n'), stop: () => terminate(child) };
}
