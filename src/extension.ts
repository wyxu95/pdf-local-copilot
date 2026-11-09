import * as vscode from 'vscode';
import path from 'node:path';
import { Paper } from './paper';
import type { Note } from './agent';
import type { Edit, ReviewFile } from './review';
import { resolveMain } from './build';
import { inside } from './project';
import { ReviewBase } from './review-base';
import fs from 'node:fs/promises';
import type { Task } from './project';
import { HistoryFiles } from './history-files';
import type { HistoryPoint, HistoryChange } from './local-history';

let output: vscode.OutputChannel, status: vscode.StatusBarItem;
let diagnostics: vscode.DiagnosticCollection, active: Paper | undefined;
let notesTree: NotesTree, changesTree: ChangesTree;
let notesView: vscode.TreeView<NoteItem>, changesView: vscode.TreeView<ReviewItem>;
let historyTree: HistoryTree, historyView: vscode.TreeView<HistoryItem>;
const papers = new Set<Paper>();
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('pdfLocal.history', new HistoryFiles(), { isReadonly: true, isCaseSensitive: true }));
  const reviewBase = new ReviewBase(); context.subscriptions.push(reviewBase, vscode.workspace.registerTextDocumentContentProvider('pdfLocal.reviewBase', reviewBase));
  output = vscode.window.createOutputChannel('PDF Local Copilot'); diagnostics = vscode.languages.createDiagnosticCollection('pdfLocal');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 30); status.command = 'pdfLocal.selectPage';
  notesTree = new NotesTree(); changesTree = new ChangesTree();
  notesView = vscode.window.createTreeView('pdfLocal.notes', { treeDataProvider: notesTree, manageCheckboxStateManually: true });
  changesView = vscode.window.createTreeView('pdfLocal.changes', { treeDataProvider: changesTree, manageCheckboxStateManually: true });
  historyTree = new HistoryTree(); historyView = vscode.window.createTreeView('pdfLocal.history', { treeDataProvider: historyTree }); context.subscriptions.push(historyView);
  context.subscriptions.push(output, diagnostics, status, notesView, changesView,
    notesView.onDidChangeCheckboxState(e => { for (const [item, checked] of e.items) item.paper.selectNote(item.note.id, checked === vscode.TreeItemCheckboxState.Checked); }),
    changesView.onDidChangeCheckboxState(e => { for (const [item, checked] of e.items) item.paper.selectReviewEdits(item.edit?.id || item.file.file, checked === vscode.TreeItemCheckboxState.Checked, !item.edit); }));
  const register = (name: string, action: (arg?: any) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(`pdfLocal.${name}`, async arg => { try { return await action(arg); } catch (e) { report(e); } }));
  let routing = Promise.resolve();
  const routeTabs = (tabs: readonly vscode.Tab[]) => {
    for (const tab of new Set(tabs)) routing = routing.then(async () => {
      for (const paper of papers) if (await paper.routeEditorFromChat(tab)) break;
    }).catch(report);
  };
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => routeTabs([...event.opened, ...event.changed.filter(tab => tab.isActive)])));
  const open = async (uri?: vscode.Uri, panel?: vscode.WebviewPanel) => {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任此工作区，以启动本地工具。');
    if (!(uri instanceof vscode.Uri)) uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== 'file' || !/\.(tex|pdf)$/i.test(uri.fsPath)) uri = (await vscode.window.showOpenDialog({ filters: { '论文 PDF / LaTeX': ['pdf', 'tex'] }, canSelectMany: false }))?.[0];
    if (!uri) return;
    const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath; if (!root) throw new Error('请先打开包含论文源文件的项目文件夹。');
    const candidates = await resolveMain(uri.fsPath, root);
    const main = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(candidates.map(file => ({ label: path.relative(root, file), file })), { title: '选择此 PDF 对应的 LaTeX 主文件' }))?.file;
    if (!main) { if (!candidates.length) throw new Error('项目中没有找到 LaTeX 主文件，请选择包含源文件的文件夹。'); return; }
    const existing = [...papers].find(p => p.main === main);
    if (existing) { panel?.dispose(); existing.panel.reveal(); setActive(existing); return existing; }
    await context.workspaceState.update('lastPaper', { root, main });
    if (!panel) {
      const source = uri.fsPath.toLowerCase().endsWith('.tex') ? uri : vscode.Uri.file(main);
      if (vscode.window.activeTextEditor?.document.uri.toString() !== source.toString()) await vscode.window.showTextDocument(source, { preview: false, viewColumn: vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === source.toString())?.viewColumn });
      await vscode.commands.executeCommand('workbench.action.newGroupRight');
    }
    const paper = new Paper(context, root, main, {
      output, diagnostics, reviewBase, refresh, activate: setActive, report,
      closed: p => { papers.delete(p); if (active === p) setActive([...papers][0]); }
    }, panel);
    papers.add(paper); setActive(paper); await paper.open(); routeTabs(vscode.window.tabGroups.all.flatMap(group => group.tabs)); return paper;
  };
  register('open', async uri => { await open(uri); });
  const recoverPaper = async (state: any, panel: vscode.WebviewPanel) => {
    if (state?.root && state?.main && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(state.main))) return { root: state.root as string, main: state.main as string };
    const last = context.workspaceState.get<{ root: string; main: string }>('lastPaper'); if (last) return last;
    const candidates: { root: string; main: string }[] = [];
    for (const key of context.workspaceState.keys().filter(key => key.startsWith('task:'))) { const task = context.workspaceState.get<Task>(key); if (task) candidates.push({ root: task.root, main: path.join(task.root, task.main) }); }
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const metadata = path.join(folder.uri.fsPath, '.pdf-local-copilot');
      for (const name of await fs.readdir(metadata).catch(() => [])) if (name.endsWith('.json')) try { const value = JSON.parse(await fs.readFile(path.join(metadata, name), 'utf8')); if (typeof value.main === 'string') candidates.push({ root: folder.uri.fsPath, main: path.resolve(folder.uri.fsPath, value.main) }); } catch {}
    }
    const name = panel.title.split(' · ').pop();
    const found = candidates.find(candidate => path.basename(candidate.main) === name) || candidates[0];
    if (found) return found;
    const source = vscode.window.visibleTextEditors.find(editor => editor.document.uri.scheme === 'file' && editor.document.fileName.endsWith('.tex'));
    if (source) return { root: vscode.workspace.getWorkspaceFolder(source.document.uri)!.uri.fsPath, main: source.document.fileName };
    throw new Error('请打开对应的 TeX 文件并点击“启动 PDF 批注”，以恢复论文窗口。');
  };
  for (const [viewType, chat] of [['pdfLocal.paper', false], ['pdfLocal.chat', true]] as const) context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(viewType, {
    deserializeWebviewPanel: async (panel, state: any) => {
      try {
        const { root, main } = await recoverPaper(state, panel); await context.workspaceState.update('lastPaper', { root, main });
        let paper = [...papers].find(paper => paper.main === main);
        if (paper) { if (chat) paper.restoreChatPanel(panel); else paper.restorePdfPanel(panel, state?.page || 0); setActive(paper); routeTabs(vscode.window.tabGroups.all.flatMap(group => group.tabs)); return; }
        const pdfGroup = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType === 'pdfLocal.paper' && tab.label.endsWith(path.basename(main))));
        paper = new Paper(context, root, main, { output, diagnostics, reviewBase, refresh, activate: setActive, report, closed: p => { papers.delete(p); if (active === p) setActive([...papers][0]); } }, chat ? undefined : panel, pdfGroup?.viewColumn || Math.max(1, (panel.viewColumn || 2) - 1));
        paper.page = state?.page || 0; papers.add(paper); setActive(paper); if (chat) paper.restoreChatPanel(panel);
        await paper.open(true);
        routeTabs(vscode.window.tabGroups.all.flatMap(group => group.tabs));
      } catch (e) { report(e); panel.webview.html = `<html><body><p>请打开对应 TeX 文件，通过“启动 PDF 批注”恢复窗口。</p></body></html>`; }
    }
  }));
  register('pdfPosition', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || !editor.document.fileName.toLowerCase().endsWith('.tex')) return;
    const file = editor.document.uri.fsPath, line = editor.selection.active.line + 1;
    const owns = (paper: Paper) => inside(paper.root, file) || !!paper.task && (inside(paper.task.proposal, file) || inside(paper.task.baseline, file));
    const paper = [...papers].find(p => p.main === file) || (active && owns(active) ? active : [...papers].find(owns)) || await open(editor.document.uri);
    if (paper) { setActive(paper); await paper.revealSource(file, line); }
  });
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('pdfLocal.paper', {
    openCustomDocument: async uri => ({ uri, dispose() {} }),
    resolveCustomEditor: async (document, panel) => { try { await open(document.uri, panel); } catch (e) { report(e); panel.dispose(); } }
  }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  register('logs', () => output.show()); register('run', () => active?.revise()); register('stop', () => active?.stopAgent());
  register('selectAllNotes', () => active?.selectAllNotes()); register('sendSelectedNotes', () => active?.sendSelectedNotes());
  register('acceptSelectedEdits', () => active?.acceptSelectedEdits());
  register('compare', () => active?.compare()); register('apply', () => active?.apply()); register('endTask', () => active?.finishTask()); register('undoApplication', () => active?.undo());
  register('rebuild', () => active?.rebuild()); register('nextChange', () => active?.nextEdit(1)); register('previousChange', () => active?.nextEdit(-1));
  register('refreshReview', () => active?.refreshReview(true));
  register('refreshHistory', () => active?.refreshHistory());
  register('historyDiff', (item?: HistoryItem) => item?.change && item.paper.showLocalHistory(item.point, item.change.file));
  register('newSession', () => active?.newSession());
  register('addClaudeAgent', () => active?.addClaudeAgent());
  register('manuscript', () => active?.showManuscript()); register('proposal', () => active?.showProposal());
  register('acceptEdit', (item?: ReviewItem & { reviewId?: string }) => (item?.paper || active)?.setDecision(item?.edit?.id || item?.reviewId || active?.selectedEdit || '', 'accepted'));
  register('rejectEdit', (item?: ReviewItem & { reviewId?: string }) => (item?.paper || active)?.setDecision(item?.edit?.id || item?.reviewId || active?.selectedEdit || '', 'rejected'));
  register('reviewEdit', (item?: ReviewItem) => item?.edit ? item.paper.showEdit(item.edit.id) : active?.reviewPopup(active.selectedEdit));
  register('editNote', (item = notesView.selection[0]) => item?.paper.editNote(item.note.id)); register('deleteNote', (item = notesView.selection[0]) => item?.paper.deleteNote(item.note.id));
  register('source', (item = notesView.selection[0]) => item?.paper.showSource(item.note));
  register('revealNote', (item?: NoteItem) => item?.paper.revealNote(item.note));
  register('diff', (item = changesView.selection[0]) => item?.paper.diff(item.file.file, item.edit?.id));
  register('reject', (item = changesView.selection[0]) => item?.paper.setDecision(item.edit?.id || item.file.file, 'rejected', !item.edit));
  register('previousPage', () => active?.showPage(active.page - 1)); register('nextPage', () => active?.showPage(active.page + 1));
  register('selectPage', async () => {
    if (!active) return;
    const value = await vscode.window.showInputBox({ title: '跳转到论文页码', value: String(active.page + 1), validateInput: s => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 10001 ? undefined : '请输入有效页码' });
    if (value) await active.showPage(Number(value) - 1);
  });
  register('toggleRegion', () => active?.toggleRegion()); register('zoomIn', () => active?.zoom(.15)); register('zoomOut', () => active?.zoom(-.15)); register('fit', () => active?.zoom(0, true)); register('difference', () => active?.toggleDifference());
}
export async function deactivate() { await Promise.all([...papers].map(p => p.dispose(false))); }
function report(e: unknown) { const text = e instanceof Error ? e.message : String(e); output.appendLine(text); void vscode.window.showErrorMessage(text); }
function setActive(paper?: Paper) { active = paper; refresh(); }
function refresh() {
  notesTree?.refresh(); changesTree?.refresh(); historyTree?.refresh();
  if (historyView) historyView.message = !active ? '打开论文后查看本地修改历史。' : !active.localHistory ? '正在读取本地历史…' : active.localHistory.head ? `起点：HEAD ${active.localHistory.head.slice(0, 7)}。同意修改后生成记录，commit 后自动清空。` : '当前项目尚无 Git commit。';
  for (const [key, value] of Object.entries({ hasPaper: !!active, hasTask: !!active?.task, running: !!active?.queueActive, hasUndo: !!active?.canUndo, hasSelectedNotes: !!active?.selectedNotes.size, hasSelectedEdits: !!active?.selectedEdits.size, hasOpenNotes: !!active?.notes.some(note => !note.status || note.status === 'open'), hasAccepted: !!active?.review?.files.some(f => f.edits.some(e => e.decision === 'accepted')) })) void vscode.commands.executeCommand('setContext', `pdfLocal.${key}`, value);
  if (!active) { status.hide(); return; }
  notesView.badge = { value: active.notes.filter(note => !note.status || note.status === 'open').length, tooltip: '待处理论文批注' };
  const edits = active.review?.files.flatMap(f => f.edits) || [], pending = edits.filter(e => e.decision === 'pending').length;
  changesView.badge = { value: pending, tooltip: '待决定的修改' };
  notesView.message = active.notes.some(note => !note.status || note.status === 'open') ? '勾选或点击批注的箭头加入右侧队列，点击发送后执行。' : '在 PDF 上选中文字，点击添加批注。';
  changesView.message = active.task ? `${edits.filter(e => e.decision === 'accepted').length} 已接受 · ${pending} 待审阅；点击打开 Diff；TeX 同步定位 PDF。` : undefined;
  status.text = `$(book) ${active.page + 1}/${active.pageCount || '…'}${active.complete ? '' : '+'}${active.alignedPage === undefined ? '' : ` ↔ ${active.alignedPage + 1}`} · ${active.queueActive ? '$(sync~spin) 当前会话执行中' : 'TeXpresso'}`;
  status.tooltip = '论文页码；↔ 表示按源码对齐的修改稿页码。'; status.show();
}
class NoteItem extends vscode.TreeItem {
  constructor(readonly paper: Paper, readonly note: Note) {
    super(note.comment.replace(/\s+/g, ' ').slice(0, 70)); this.id = note.id; this.contextValue = 'pdfLocal.note';
    this.description = `第 ${note.page + 1} 页${note.anchorStatus === 'modified' ? ' · 原文已修改' : note.anchorStatus === 'orphaned' ? ' · 待重新定位' : ''}`;
    this.tooltip = new vscode.MarkdownString().appendText(note.comment).appendMarkdown('\n\n').appendText(note.quote).appendMarkdown('\n\n').appendText(note.source ? `${note.source.file}:${note.source.line}\n${note.source.text}` : '页面区域批注');
    this.checkboxState = paper.selectedNotes.has(note.id) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.command = { command: 'pdfLocal.revealNote', title: '显示 PDF 批注', arguments: [this] }; this.iconPath = new vscode.ThemeIcon('comment');
  }
}
class ReviewItem extends vscode.TreeItem {
  constructor(readonly paper: Paper, readonly file: ReviewFile, readonly edit?: Edit) {
    super(edit ? `${edit.decision === 'accepted' ? '✓' : edit.decision === 'rejected' ? '×' : '○'} ${((edit.inserted || edit.removed).replace(/\s+/g, ' ').trim() || '空白修改').slice(0, 55)}` : file.file, edit ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    this.id = edit?.id || file.file; this.contextValue = edit ? 'pdfLocal.edit' : 'pdfLocal.change';
    this.description = edit ? `第 ${edit.afterLine} 行` : `${file.edits.filter(e => e.decision === 'accepted').length}/${file.edits.length} 已接受`;
    this.checkboxState = (edit ? paper.selectedEdits.has(edit.id) : file.edits.filter(edit => edit.decision !== 'accepted').every(edit => paper.selectedEdits.has(edit.id))) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    this.iconPath = new vscode.ThemeIcon(edit ? 'diff' : 'file-code'); this.tooltip = edit ? new vscode.MarkdownString().appendText(`原文：${edit.removed}\n\n修改：${edit.inserted}`) : file.file;
    this.command = file.file.toLowerCase().endsWith('.tex') ? { command: 'pdfLocal.reviewEdit', title: '查看差异并定位 PDF', arguments: [edit ? this : new ReviewItem(paper, file, file.edits.find(edit => edit.decision !== 'accepted') || file.edits[0])] } : { command: 'pdfLocal.diff', title: '查看源码差异', arguments: [this] };
  }
}
class NotesTree implements vscode.TreeDataProvider<NoteItem> {
  private changed = new vscode.EventEmitter<void>(); readonly onDidChangeTreeData = this.changed.event;
  refresh() { this.changed.fire(); }
  getTreeItem(item: NoteItem) { return new NoteItem(item.paper, item.paper.notes.find(n => n.id === item.note.id) || item.note); }
  getParent() { return undefined; }
  getChildren() { return active?.notes.filter(note => !note.status || note.status === 'open').map(n => new NoteItem(active!, n)) || []; }
}
class ChangesTree implements vscode.TreeDataProvider<ReviewItem> {
  private changed = new vscode.EventEmitter<void>(); readonly onDidChangeTreeData = this.changed.event;
  refresh() { this.changed.fire(); }
  getTreeItem(item: ReviewItem) {
    const file = item.paper.review?.files.find(f => f.file === item.file.file) || item.file;
    return new ReviewItem(item.paper, file, item.edit ? file.edits.find(e => e.id === item.edit!.id) || item.edit : undefined);
  }
  getParent(item: ReviewItem) { return item.edit ? new ReviewItem(item.paper, item.file) : undefined; }
  getChildren(item?: ReviewItem) {
    if (!item) return active?.review?.files.filter(file => file.edits.some(edit => edit.decision !== 'accepted')).map(f => new ReviewItem(active!, f)) || [];
    const file = item.paper.review?.files.find(f => f.file === item.file.file) || item.file;
    return file.edits.filter(edit => edit.decision !== 'accepted').map(e => new ReviewItem(item.paper, file, e));
  }
}
class HistoryItem extends vscode.TreeItem {
  constructor(readonly paper: Paper, readonly point: HistoryPoint, readonly change?: HistoryChange) {
    super(change?.file || point.label, change ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.id = point.id + (change ? ':' + change.file : ''); this.contextValue = change ? 'pdfLocal.historyFile' : 'pdfLocal.historyPoint';
    this.iconPath = new vscode.ThemeIcon(change ? change.patch === undefined ? 'file-binary' : 'file-code' : 'history');
    this.description = change ? !change.beforeExists ? '新增' : !change.afterExists ? '删除' : '修改' : `${new Date(point.created).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${point.files.length} 个文件`;
    this.tooltip = `${point.label}\n${new Date(point.created).toLocaleString()}${change ? '\n' + change.file : ''}`;
    if (change) this.command = { command: 'pdfLocal.historyDiff', title: '查看此处本地历史', arguments: [this] };
  }
}
class HistoryTree implements vscode.TreeDataProvider<HistoryItem> {
  private changed = new vscode.EventEmitter<void>(); readonly onDidChangeTreeData = this.changed.event;
  refresh() { this.changed.fire(); }
  getTreeItem(item: HistoryItem) { return item; }
  getParent(item: HistoryItem) { return item.change ? new HistoryItem(item.paper, item.point) : undefined; }
  getChildren(item?: HistoryItem) {
    if (item) return item.point.files.map(change => new HistoryItem(item.paper, item.point, change));
    return active?.localHistory?.points.slice().reverse().map(point => new HistoryItem(active!, point)) || [];
  }
}
