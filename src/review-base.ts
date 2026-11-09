import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadReview, materialize } from './review';

export class ReviewBase implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private contents = new Map<string, string>();
  private changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  set(taskId: string, file: string, text: string, root: string) {
    const uri = vscode.Uri.from({ scheme: 'pdfLocal.reviewBase', path: `/${taskId}/${file}`, query: encodeURIComponent(root) }), key = uri.toString();
    if (this.contents.get(key) !== text) { this.contents.set(key, text); this.changed.fire(uri); }
    return uri;
  }
  async provideTextDocumentContent(uri: vscode.Uri) {
    if (this.contents.has(uri.toString())) return this.contents.get(uri.toString())!;
    const [, id, ...parts] = uri.path.split('/'), file = parts.join('/'), root = decodeURIComponent(uri.query || '');
    if (!root || !/^[\w-]+$/.test(id) || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) return '';
    try {
      const task = JSON.parse(await fs.readFile(path.join(root, '.pdf-local-copilot', 'tasks', id, 'task.json'), 'utf8'));
      const review = await loadReview(task), data = review?.files.find(data => data.file === file);
      const content = data ? materialize(data, edit => edit.decision === 'accepted')?.toString('utf8') || '' : '';
      this.contents.set(uri.toString(), content); return content;
    } catch { return ''; }
  }
  dispose() { this.changed.dispose(); this.contents.clear(); }
}
