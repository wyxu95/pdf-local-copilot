import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function run() {
  const root = process.env.PDF_COPILOT_ROOT!;
  const paper = path.join(root, 'output/host/paper/main.tex');
  await vscode.workspace.getConfiguration().update('workbench.colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration().update('window.zoomLevel', 0, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration().update('window.menuStyle', 'custom', vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('git').update('openRepositoryInParentFolders', 'never', vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('pdfLocal').update('codexPath', path.join(root, 'output/host/fake-codex'), vscode.ConfigurationTarget.Global);
  const extension = vscode.extensions.getExtension('local-paper-tools.pdf-local-copilot');
  await vscode.commands.executeCommand('notifications.clearAll');
  if (!extension) throw new Error('Extension did not load.');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.window.showTextDocument(vscode.Uri.file(paper));
  const oldReference = path.join(root, 'output/host/profile/User/globalStorage/local-paper-tools.pdf-local-copilot/tasks/legacy-review/proposal/refs.bib');
  await vscode.window.showTextDocument(vscode.Uri.file(oldReference), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
  vscode.window.onDidChangeTextEditorSelection(event => {
    if (path.dirname(event.textEditor.document.uri.fsPath) === path.dirname(paper)) {
      const range = event.selections[0]; void fs.writeFile(path.join(root, 'output/host/diff-selection.json'), JSON.stringify({ file: path.basename(event.textEditor.document.uri.fsPath), line: range.start.line, text: event.textEditor.document.getText(range) }));
    }
    if (event.textEditor.document.uri.fsPath === paper) {
      const range = event.selections[0];
      void fs.writeFile(path.join(root, 'output/host/source-jump.json'), JSON.stringify({ file: paper, line: range.start.line, text: event.textEditor.document.getText(range) }));
    }
  });
  vscode.workspace.onDidChangeTextDocument(event => {
    if (event.document.uri.scheme === 'pdfLocal.reviewBase') void fs.writeFile(path.join(root, 'output/host/diff-base.json'), JSON.stringify({ file: path.basename(event.document.uri.path), text: event.document.getText() }));
  });
  const recordHistoryDiff = async () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff) || input.modified.scheme !== 'pdfLocal.history') return;
    const before = await vscode.workspace.openTextDocument(input.original), after = await vscode.workspace.openTextDocument(input.modified);
    await fs.writeFile(path.join(root, 'output/host/history-diff.json'), JSON.stringify({ before: before.getText(), after: after.getText(), readonly: vscode.workspace.fs.isWritableFileSystem(input.modified.scheme) === false }));
  };
  vscode.window.onDidChangeActiveTextEditor(() => { void recordHistoryDiff(); });
  await fs.writeFile(path.join(root, 'output/host/ready.json'), JSON.stringify({ main: paper, activated: extension.isActive }));
  if (process.env.PDF_COPILOT_HOLD) {
    // The interactive browser check creates the sentinel when it is finished.
    await new Promise<void>(resolve => {
      const timer = setInterval(async () => {
        try { await fs.access(path.join(root, 'output/host/done')); clearInterval(timer); resolve(); } catch {}
      }, 500);
    });
  }
}
