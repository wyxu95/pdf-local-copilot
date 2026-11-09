import * as vscode from 'vscode';
import { readHistoryFile } from './local-history';

export function historyUri(root: string, main: string, head: string, point: string, side: 'before' | 'after', file: string) {
  return vscode.Uri.from({ scheme: 'pdfLocal.history', path: `/${head}/${point}/${side}/${file}`, query: JSON.stringify({ root, main }) });
}
export class HistoryFiles implements vscode.FileSystemProvider {
  readonly onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>().event;
  watch() { return new vscode.Disposable(() => {}); }
  async readFile(uri: vscode.Uri) {
    const [, head, point, side, ...parts] = uri.path.split('/'), { root, main } = JSON.parse(uri.query);
    if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) || side !== 'before' && side !== 'after') throw vscode.FileSystemError.FileNotFound(uri);
    return readHistoryFile(root, main, head, point, side, parts.join('/'));
  }
  async stat(uri: vscode.Uri) { return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: (await this.readFile(uri)).byteLength, permissions: vscode.FilePermission.Readonly }; }
  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): never { throw vscode.FileSystemError.NoPermissions(); }
  writeFile(): never { throw vscode.FileSystemError.NoPermissions(); }
  delete(): never { throw vscode.FileSystemError.NoPermissions(); }
  rename(): never { throw vscode.FileSystemError.NoPermissions(); }
}
