import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LivePreview, type PagePoint } from './live';
import type { Frame, FrameHeader } from './protocol';
import { type Task, changes, inside, WorkingTree } from './project';
import { type Note, type Agent, runAgent } from './agent';
import { type Review, type Edit, type Decision, type ReviewRequest, makeReview, materialize, reviewPlan, decide, editPosition, loadReview, saveReview, mapLine, associateReview, resolvedNoteIds } from './review';
import { BuildManager, engineFor, parseProblems, type BuildStep } from './build';
import { trackNotes, quoteGeometry, nearbyGeometry, regionGeometry, locateAnnotation } from './anchors';
import { applyWithUndo, undoApplication, recordWorkspace } from './history';
import { ConversationStore, type QueuedTurn } from './conversation';
import { configuredAgents, type CustomAgent, type AgentProfile } from './agents';
import { nearestTextPoint, textContext } from './view-geometry';
import { refineSourceLocation } from './source-location';
import { modelCatalog, runOptions, type ModelCatalog, type RunOptions } from './models';
import type { AgentActivity, AgentUpdate } from './agent-output';
import type { ReviewBase } from './review-base';
import { alignReviewSource } from './review-geometry';
import { LocalHistory, type HistoryPoint } from './local-history';
import { historyUri } from './history-files';
import { displayHistoryLabel } from './history-label';
import { gitHead, committedReviewFiles, acceptCommittedReview } from './commit-review';
import { FrameDelivery } from './frame-delivery';

interface UI {
  output: vscode.OutputChannel; diagnostics: vscode.DiagnosticCollection;
  reviewBase: ReviewBase;
  refresh(): void; activate(paper: Paper): void; report(error: unknown): void; closed(paper: Paper): void;
}
interface Marker { id: string; page: number; rects: number[][]; decision: Decision; label: string; originLabel?: string; unresolved?: boolean; bounds?: number[] }
const inputFile = (file: string) => /\.(tex|bib|sty|cls|bst|bbx|cbx|png|jpe?g|pdf|svg|eps|csv|[cm]?js|jsx|tsx?|py|c|h|cpp|hpp|rs|java|go|txt)$/i.test(file) || path.basename(file) === '.latexmkrc';

export class Paper {
  panel: vscode.WebviewPanel;
  notes: Note[] = []; review?: Review; task?: Task; selectedNotes = new Set<string>(); selectedEdits = new Set<string>();
  page = 0; alignedPage?: number; pageCount = 0; complete = false; busy = false; selectedEdit?: string; lastApplication?: string;
  private before?: LivePreview; private after?: LivePreview; private proposalPanel?: vscode.WebviewPanel; private chatPanel?: vscode.WebviewPanel;
  private beforeBuild?: BuildManager; private afterBuild?: BuildManager;
  private run?: ReturnType<typeof runAgent>; private disposed = false; private serial = Promise.resolve();
  private resources: vscode.Disposable[] = []; private threads: vscode.CommentThread[] = []; private comments: vscode.CommentController;
  private tool: 'text' | 'region' = 'text'; private zoomLevel = 1; private difference = false;
  private totals = { before: { pages: 0, complete: false }, after: { pages: 0, complete: false } };
  private noteFile: string; private key: string; private currentSide: 'before' | 'after' = 'before';
  private versions = new Map<string, string>(); private buildTimers = new Map<string, NodeJS.Timeout>();
  private proposalVersions = new Map<string, string>();
  private anchorTimer?: NodeJS.Timeout; private anchoring = false; private alignmentGeneration = 0;
  private noteWrites: Promise<void> = Promise.resolve(); private decisions: Promise<void> = Promise.resolve();
  private diagnosticFiles = new Set<string>();
  private sourceGeneration = 0;
  private previewSessions = { before: 0, after: 0 };
  private frameDeliveries = new WeakMap<vscode.WebviewPanel, FrameDelivery>();
  private mainViewSide: 'before' | 'after' = 'before';
  private sourceGroup?: vscode.TabGroup;
  private pendingChatFocus?: { draft?: string };
  private openingChat?: Promise<void>;
  private referenceGeneration = 0;
  private markerTimer?: NodeJS.Timeout; private markerGeneration = 0;
  private markerVersions = new Map<string, string>();
  localHistory?: LocalHistory;
  private conversation: ConversationStore;
  private catalogs: Record<string, ModelCatalog> = {};
  private workingTree?: WorkingTree;
  private processingQueue = false; private draining?: Promise<void>;
  private chatReady = false; private pendingNoteSend?: string[];
  get queueActive() { return this.busy || this.processingQueue; }
  get canUndo() { return this.task?.mode === 'workspace' ? !!this.review && reviewPlan(this.review, false).length > 0 : !!this.lastApplication; }
  private markers: { before: Marker[]; after: Marker[] } = { before: [], after: [] };
  private proposalWatcher?: vscode.FileSystemWatcher;
  private configuration: vscode.WorkspaceConfiguration;
  constructor(private context: vscode.ExtensionContext, readonly root: string, readonly main: string, private ui: UI, panel?: vscode.WebviewPanel, column = vscode.ViewColumn.Active) {
    this.configuration = vscode.workspace.getConfiguration('pdfLocal', vscode.Uri.file(main));
    this.key = `task:${root}:${main}`; this.lastApplication = context.workspaceState.get<string>(`undo:${root}`);
    this.noteFile = path.join(root, '.pdf-local-copilot', `${createHash('sha256').update(path.relative(root, main)).digest('hex').slice(0, 12)}.json`);
    this.conversation = new ConversationStore(path.join(path.dirname(this.noteFile), 'conversations', path.basename(this.noteFile)), context.workspaceState.get<Agent>('lastAgent', 'codex'));
    this.comments = vscode.comments.createCommentController(`pdfLocal-${randomUUID()}`, 'PDF Annotations'); this.resources.push(this.comments);
    this.panel = this.createPanel('before', column, panel); const created = this.panel; created.onDidDispose(() => { if (this.panel === created) void this.dispose(); });
  }
  restorePdfPanel(panel: vscode.WebviewPanel, page = 0) {
    const old = this.panel; this.panel = this.createPanel('before', panel.viewColumn || vscode.ViewColumn.Active, panel);
    this.page = page; panel.onDidDispose(() => { if (this.panel === panel) void this.dispose(); });
    if (old !== panel) old.dispose(); this.syncPanel(panel, 'before'); this.post(panel, { type: 'navigate', page });
  }
  restoreChatPanel(panel: vscode.WebviewPanel) {
    const old = this.chatPanel; this.chatReady = false;
    this.chatPanel = this.createPanel('chat', panel.viewColumn || vscode.ViewColumn.Beside, panel);
    panel.onDidDispose(() => { if (this.chatPanel === panel) { this.chatPanel = undefined; this.chatReady = false; } });
    if (old && old !== panel) old.dispose(); this.syncPanel(panel, this.mainViewSide);
  }
  private createPanel(side: 'before' | 'after' | 'chat', column: vscode.ViewColumn, supplied?: vscode.WebviewPanel, preserveFocus = false) {
    const chatOnly = side === 'chat';
    const panel = supplied || vscode.window.createWebviewPanel(chatOnly ? 'pdfLocal.chat' : 'pdfLocal.paper', '', { viewColumn: column, preserveFocus }, { enableScripts: true, retainContextWhenHidden: true });
    this.frameDeliveries.delete(panel);
    const panelSide = (): 'before' | 'after' => chatOnly || panel === this.panel ? this.mainViewSide : side as 'before' | 'after';
    panel.title = `${chatOnly ? 'Paper Chat' : side === 'before' ? 'Paper' : 'Working Draft'} · ${path.basename(this.main)}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    panel.iconPath = new vscode.ThemeIcon(chatOnly ? 'comment-discussion' : side === 'before' ? 'book' : 'git-compare');
    this.resources.push(panel.onDidChangeViewState(e => { if (e.webviewPanel.active) { this.currentSide = panelSide(); this.ui.activate(this); if (chatOnly) this.flushChatActions(); else this.post(panel, { type: 'reportVisiblePage' }); } else if (!chatOnly) this.post(panel, { type: 'dismissReview' }); }));
    this.resources.push(panel.webview.onDidReceiveMessage(m => {
      const side = panelSide();
      if (m.type === 'ready' && typeof m.viewId === 'string') this.frameDeliveries.set(panel, new FrameDelivery(m.viewId));
      if (m.type === 'imageMissing') {
        const delivery = this.frameDeliveries.get(panel);
        if (delivery && delivery.viewId === m.viewId && (m.side === 'before' || m.side === 'after') && m.session === this.previewSessions[m.side as 'before' | 'after']) {
          delivery.forget(m.side, m.page); void this.sendPage(panel, m.side, m.page, m.session, true);
        }
        return;
      }
      if (m.type === 'pageRelative') { this.currentSide = side; this.ui.activate(this); void this.showPage(this.page + (m.delta > 0 ? 1 : -1)).catch(this.ui.report); return; }
      if (m.type === 'requestPage') { void this.sendPage(panel, m.side === 'before' || m.side === 'after' ? m.side : side, m.page, m.session); return; }
      if (m.type === 'visiblePage' && Number.isInteger(m.page) && m.page >= 0 && m.page <= 10000) { if (panel.active || panel === this.panel && panel.visible) { this.currentSide = side; this.page = m.page; this.ui.activate(this); } return; }
      if (m.type === 'sourceJump') { void this.jumpToSource(m, side).catch(this.ui.report); return; }
      if (m.type === 'referencePreview' || m.type === 'referenceImage' || m.type === 'referenceJump') {
        const generation = ++this.referenceGeneration;
        void this.referenceAction(m, panel, side, generation).catch(error => {
          if (m.type === 'referenceJump') this.ui.report(error);
          else if (generation === this.referenceGeneration) this.post(panel, { type: m.type, requestId: m.requestId, error: error instanceof Error ? error.message : String(error) });
        }); return;
      }
      if (m.type === 'chatSend') { void this.sendChat(m.instruction, m.agent, m.ids, m.options).catch(e => this.both({ type: 'chatError', message: e instanceof Error ? e.message : String(e) })); return; }
      if (m.type === 'chatDraft' && typeof m.text === 'string') {
        try {
          this.conversation.value.draft = m.text.slice(0, 50000);
          if (!this.chatState().lockedAgent && this.agentProfiles().some(profile => profile.id === m.agent)) this.conversation.value.agent = m.agent;
          this.conversation.value.runOptions = runOptions(m.options, this.agentProfile(this.conversation.value.agent).type);
          void this.conversation.save();
        } catch (e) { this.both({ type: 'chatError', message: String(e) }); }
        return;
      }
      if (m.type === 'chooseModel') { void this.chooseModel().catch(this.ui.report); return; }
      if (m.type === 'showLogs') { this.ui.output.show(true); return; }
      if (m.type === 'addAgent') { void this.addClaudeAgent().catch(this.ui.report); return; }
      if (m.type === 'stopQueue') { void this.stopAgent().catch(this.ui.report); return; }
      if (m.type === 'resumeQueue') { this.conversation.value.paused = false; this.startQueue(); return; }
      if (m.type === 'removeQueuedTurn' && typeof m.id === 'string') { this.conversation.value.queue = this.conversation.value.queue.filter(turn => turn.id !== m.id); void this.saveConversation(); return; }
      if (m.type === 'newSession') { void this.newSession().catch(e => this.both({ type: 'chatError', message: e instanceof Error ? e.message : String(e) })); return; }
      if (m.type === 'toggleManuscript') { if (this.task?.mode === 'workspace') void this.compare().catch(this.ui.report); else if (this.mainViewSide === 'after') this.showManuscript(); else this.showProposal(); return; }
      if (m.type === 'undoWorkingChanges') { void this.undo().catch(e => this.both({ type: 'chatError', message: String(e) })); return; }
      this.serial = this.serial.then(async () => {
        this.currentSide = side; this.ui.activate(this);
        if (m.type === 'ready') this.syncPanel(panel, side, true);
        else if (m.type === 'annotate') await this.annotate(m, side);
        else if (m.type === 'reviewChange' && typeof m.id === 'string') this.showReviewCard(m.id, panel);
        else if (m.type === 'reviewDecision' && typeof m.id === 'string' && ['accepted', 'rejected', 'pending'].includes(m.decision)) { await this.setDecision(m.id, m.decision); this.post(panel, { type: 'reviewDecisionDone', id: m.id }); }
        else if (m.type === 'reviewFollowup' && typeof m.id === 'string') await this.followupReview(m.id);
        else if (m.type === 'reviewDiff' && typeof m.id === 'string') { const file = this.review?.files.find(file => file.edits.some(edit => edit.id === m.id)); if (file) await this.diff(file.file, m.id); }
        else if (m.type === 'noteAction' && typeof m.id === 'string') await this.notePopup(m.id);
        else if (m.type === 'revealNote' && typeof m.id === 'string') { const note = this.notes.find(n => n.id === m.id); if (note) await this.revealNote(note); }
        else if (m.type === 'runNote' && typeof m.id === 'string') await this.sendNote(m.id);
        else if (m.type === 'removeQueuedNote' && typeof m.id === 'string') this.selectNote(m.id, false);
        else if (m.type === 'editNote' && typeof m.id === 'string') await this.updateNote(m.id, m.comment);
        else if (m.type === 'deleteNote' && typeof m.id === 'string') await this.deleteNote(m.id);
      }).catch(e => {
        if (m.type === 'reviewDecision') { this.post(panel, { type: 'reviewError', id: m.id, message: String(e) }); return; }
        if (m.type === 'annotate' || m.type === 'editNote') { this.post(panel, { type: 'annotationError', draftId: m.draftId, id: m.id, message: e instanceof Error ? e.message : String(e) }); this.log(String(e)); }
        else this.ui.report(e);
      });
    }));
    const nonce = randomUUID().replaceAll('-', ''), resource = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', file));
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('style.css')}"><title>Paper PDF</title></head><body class="${chatOnly ? 'chat-only' : 'secondary'}"><div id="reader"><main id="viewport"><div id="pages"></div></main><aside id="chat" aria-label="Paper Chat"><header class="chat-header"><strong>Current Session</strong><button id="new-session" title="Start a new session to reset the agent context">New Session</button></header><div id="chat-messages" role="log" aria-live="polite"></div><div id="task-queue"></div><div id="chat-error" role="alert" hidden></div><section id="chat-composer"><div id="queued-notes"></div><textarea id="chat-input" rows="4" aria-label="Revision request" placeholder="Describe the revision, or select PDF annotations…"></textarea><div class="chat-controls"><select id="chat-agent" aria-label="Local Agent"><option value="codex">Codex</option><option value="claude">Claude Code</option></select><button id="resume-queue" hidden>Resume Queue</button><button id="stop-chat" hidden>Stop</button><button id="send-chat" class="primary">Send</button></div><div class="model-controls"><label>Model<select id="chat-model" aria-label="Model"></select></label><label>Reasoning Effort<select id="chat-effort" aria-label="Reasoning Effort"></select></label></div><p class="chat-hint">Enter to send · Shift+Enter for a newline</p><p id="session-status">Select annotations in the sidebar and send them together.</p></section></aside></div><script nonce="${nonce}" src="${resource('app.js')}"></script></body></html>`;
    return panel;
  }
  private post(panel: vscode.WebviewPanel | undefined, value: object) { if (!this.disposed && panel) void panel.webview.postMessage(value); }
  private postFrame(panel: vscode.WebviewPanel | undefined, type: 'frame' | 'pageFrame', side: 'before' | 'after', session: number, frame: Frame, forceImage = false) {
    const delivery = panel && this.frameDeliveries.get(panel);
    if (delivery) this.post(panel, delivery.encode(type, side, session, frame, forceImage));
  }
  private panelFor(side: 'before' | 'after') { return side === this.mainViewSide ? this.panel : this.proposalPanel; }
  private both(value: object) {
    const type = (value as { type: string }).type;
    if (type !== 'agentOutput') { this.post(this.panel, value); this.post(this.proposalPanel, value); }
    if (['chatState', 'agentOutput', 'chatSent', 'chatError'].includes(type)) this.post(this.chatPanel, value);
  }
  private syncPanel(panel: vscode.WebviewPanel, side: string, forceImage = false) {
    const chatOnly = panel === this.chatPanel;
    this.post(panel, { type: 'init', root: this.root, main: this.main, page: this.page, side, tool: this.tool, zoom: this.zoomLevel, hasTask: !!this.task, notes: this.notes, difference: this.difference, markers: this.markers, chatVisible: chatOnly, chatOnly });
    if (chatOnly) { this.chatReady = true; this.post(panel, { type: 'chatState', ...this.chatState() }); this.flushChatActions(); return; }
    for (const [s, preview] of [['before', this.before], ['after', this.after]] as const) if (preview?.lastFrame) {
      this.post(panel, { type: 'previewState', side: s, session: this.previewSessions[s], ...preview.snapshot() });
      this.postFrame(panel, 'frame', s, this.previewSessions[s], preview.lastFrame, forceImage);
    }
    this.post(panel, { type: 'chatState', ...this.chatState() });
  }
  private async sendPage(panel: vscode.WebviewPanel, side: 'before' | 'after', page: number, session: number, forceImage = false) {
    if (!Number.isInteger(page) || page < 0 || page > 10000 || session !== this.previewSessions[side]) return;
    const preview = side === 'before' ? this.before : this.after; if (!preview) return;
    try { const frame = await preview.readPage(page); if (session === this.previewSessions[side]) this.postFrame(panel, 'pageFrame', side, session, frame, forceImage); }
    catch (e) { if (session === this.previewSessions[side]) this.post(panel, { type: 'pageError', side, session, page, message: e instanceof Error ? e.message : String(e) }); }
  }
  private async referenceAction(message: { type: string; requestId: number; session: number; sequence: number; revision: number; page: number; linkIndex: number; bounds?: number[]; width?: number }, panel: vscode.WebviewPanel, side: 'before' | 'after', generation: number) {
    const preview = side === 'before' ? this.before : this.after;
    if (!preview || message.session !== this.previewSessions[side] || !Number.isInteger(message.page) || message.page < 0 || message.page > 10000 || !Number.isInteger(message.linkIndex)) return;
    const source = await preview.readPage(message.page);
    if (generation !== this.referenceGeneration) return;
    if (source.header.sequence !== message.sequence || source.header.revision !== message.revision) throw new Error('The reference has moved. Hover over it again.');
    const link = source.header.annotations?.links[message.linkIndex];
    if (!link?.uri.startsWith('#')) return;
    const result = await preview.reference(link);
    if (generation !== this.referenceGeneration) return;
    if (message.type === 'referenceImage') {
      const bounds = message.bounds, page = result.frame.header.bounds;
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || !Number.isInteger(message.width) || message.width! < 1 || message.width! > 4096) return;
      const rect = [Math.max(page[0], bounds[0]), Math.max(page[1], bounds[1]), Math.min(page[2], bounds[2]), Math.min(page[3], bounds[3])];
      if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
      const frame = await preview.capture(result.target.page, rect, message.width);
      if (generation === this.referenceGeneration) this.post(panel, { type: 'referenceImage', requestId: message.requestId, target: result.target, header: frame.header, data: frame.bytes.toString('base64') });
      return;
    }
    if (message.type === 'referenceJump') {
      this.page = result.target.page; preview.showPage(result.target.page); this.ui.refresh();
      this.post(panel, { type: 'referencePosition', side, session: message.session, target: result.target });
    } else this.post(panel, { type: 'referencePreview', requestId: message.requestId, target: result.target, header: result.frame.header, data: result.frame.bytes.toString('base64') });
  }
  private async jumpToSource(m: { header: FrameHeader; x: number; y: number; session: number }, side: 'before' | 'after') {
    const preview = side === 'before' ? this.before : this.after;
    if (!preview || m.session !== this.previewSessions[side] || !m.header || !Number.isFinite(m.x) || !Number.isFinite(m.y)) throw new Error('This page has not finished rendering.');
    const header = await preview.activatePage(m.header.page);
    if (m.header.sequence !== header.sequence && JSON.stringify(m.header.characters) !== JSON.stringify(header.characters)) throw new Error('The page content has changed. Click the updated passage again.');
    const [x, y] = nearestTextPoint(header.characters || [], m.x, m.y) || [m.x, m.y];
    const location = await preview.locate(header, x, y);
    if (!inside(preview.root, location.file)) throw new Error('No project LaTeX source is mapped to this location.');
    const target = side === 'before' && this.task ? path.join(this.root, path.relative(preview.root, location.file)) : location.file;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const sourceLine = this.task ? mapLine(await fs.readFile(location.file, 'utf8'), document.getText(), location.line).line : location.line;
    const { line, column, length } = refineSourceLocation(document.getText(), sourceLine, location.column, location.word, textContext(header.characters || [], x, y));
    const range = new vscode.Range(line, column, line, Math.min(document.lineAt(line).text.length, column + length));
    const editor = await vscode.window.showTextDocument(document, { viewColumn: this.sourceColumn(target), selection: range, preserveFocus: false });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
  private binary() { return this.configuration.get<string>('texpressoPath') || path.join(this.context.extensionPath, 'native', 'texpresso'); }
  private sourceColumn(file: string) {
    const groups = vscode.window.tabGroups.all.filter(group => group.viewColumn !== this.chatPanel?.viewColumn);
    for (const target of [file, this.main]) {
      const group = groups.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === target));
      if (group) { this.sourceGroup = group; return group.viewColumn; }
    }
    const diff = groups.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff && [file, this.main].includes(tab.input.modified.fsPath)));
    if (diff) { this.sourceGroup = diff; return diff.viewColumn; }
    return this.sourceGroup && groups.includes(this.sourceGroup) ? this.sourceGroup.viewColumn : Math.max(1, (this.panel.viewColumn || 2) - 1);
  }
  async routeEditorFromChat(tab: vscode.Tab) {
    if (!this.chatPanel || this.disposed || tab.group.viewColumn !== this.chatPanel.viewColumn || !tab.group.tabs.includes(tab)) return false;
    const input = tab.input;
    if (!(input instanceof vscode.TabInputText || input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook)) return false;
    const uri = input instanceof vscode.TabInputTextDiff ? input.modified : input.uri;
    const viewColumn = this.sourceColumn(uri.fsPath); if (viewColumn === tab.group.viewColumn) return false;
    const selection = vscode.window.visibleTextEditors.find(editor => editor.viewColumn === tab.group.viewColumn && editor.document.uri.toString() === uri.toString())?.selection;
    const options = { viewColumn, preview: tab.isPreview, preserveFocus: false, selection };
    if (input instanceof vscode.TabInputTextDiff) await vscode.commands.executeCommand('vscode.diff', input.original, input.modified, tab.label, options);
    else if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) await vscode.commands.executeCommand('vscode.openWith', uri, input instanceof vscode.TabInputCustom ? input.viewType : input.notebookType, options);
    else await vscode.window.showTextDocument(uri, options);
    if (tab.group.tabs.includes(tab)) await vscode.window.tabGroups.close(tab, true);
    return true;
  }
  private dirtyProjectDocument() { return vscode.workspace.textDocuments.find(doc => doc.isDirty && doc.uri.scheme === 'file' && inside(this.root, doc.uri.fsPath) && !inside(path.join(this.root, '.pdf-local-copilot'), doc.uri.fsPath)); }
  private log(text: string) { if (!this.disposed) this.ui.output.append(text); }
  async open(restoring = false) {
    try {
      const saved = JSON.parse(await fs.readFile(this.noteFile, 'utf8')); this.notes = saved.notes;
      if (!Array.isArray(this.notes)) throw new Error('Invalid annotation data');
      this.notes.forEach((note, index) => { note.number ??= index + 1; });
      for (const [file, text] of Object.entries(saved.sources || {})) if (typeof text === 'string') this.versions.set(file, text);
      for (const [file, text] of Object.entries(saved.proposalSources || {})) if (typeof text === 'string') this.proposalVersions.set(file, text);
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const projectConversation = await fs.access(this.conversation.file).then(() => true, () => false);
    await this.conversation.load();
    this.selectedEdits = new Set(this.conversation.value.selectedEdits || []);
    await this.loadModels();
    if (!this.agentProfiles().some(profile => profile.id === this.conversation.value.agent)) this.conversation.value.agent = this.agentProfiles()[0].id;
    this.selectedNotes = new Set(this.conversation.value.selectedNotes.filter(id => this.notes.some(n => n.id === id)));
    const saved = projectConversation ? undefined : this.context.workspaceState.get<Task>(this.key);
    if (saved) { try { this.task = JSON.parse(await fs.readFile(path.join(saved.dir, 'task.json'), 'utf8')); await fs.access(this.task!.proposal); } catch { this.task = undefined; await this.context.workspaceState.update(this.key, undefined); } }
    if (this.task && !this.conversation.value.task) this.conversation.value.task = this.task;
    const previous = this.conversation.value.task;
    if (previous && previous.root === this.root && previous.main === path.relative(this.root, this.main) && (inside(path.join(this.context.globalStorageUri.fsPath, 'tasks'), previous.dir) || inside(path.join(this.root, '.pdf-local-copilot', 'tasks'), previous.dir))) {
      try { this.conversation.value.task = JSON.parse(await fs.readFile(path.join(previous.dir, 'task.json'), 'utf8')); } catch { this.conversation.value.task = undefined; }
    } else if (previous) this.conversation.value.task = undefined;
    await this.adoptWorkspaceTask();
    this.localHistory = new LocalHistory(this.root, path.relative(this.root, this.main));
    await this.refreshHistory(); void this.watchHistoryGit().catch(this.ui.report);
    await this.loadVersions(); this.ui.refresh();
    this.resources.push(vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme === 'file' && inside(this.root, e.document.uri.fsPath) && !inside(path.join(this.root, '.pdf-local-copilot'), e.document.uri.fsPath)) {
        this.before?.update(e.document.uri.fsPath, e.document.getText()); void this.sourceChanged(e.document.uri.fsPath, e.document.getText());
      }
    }), vscode.workspace.onDidSaveTextDocument(doc => {
      if (inside(this.root, doc.uri.fsPath) && !inside(path.join(this.root, '.pdf-local-copilot'), doc.uri.fsPath)) {
        if (inputFile(doc.uri.fsPath)) this.scheduleBuild('before');
        if (this.task?.mode === 'workspace' && !this.queueActive) void this.refreshReview(true).catch(e => this.log(String(e)));
      }
    }),
    vscode.workspace.onDidCloseTextDocument(doc => { this.before?.closeBuffer(doc.uri.fsPath); }));
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.root), '**/*'));
    const changed = (uri: vscode.Uri) => {
      if (!uri.fsPath.includes(`${path.sep}.pdf-local-copilot${path.sep}`) && !uri.fsPath.includes(`${path.sep}.git${path.sep}`) && (inputFile(uri.fsPath) || uri.fsPath.endsWith('.md'))) {
        void this.workingTree?.capture().catch(e => this.log(String(e)));
        if (inputFile(uri.fsPath)) { this.before?.buildPending(true); this.before?.rescan(); this.scheduleBuild('before'); }
        if (uri.fsPath.endsWith('.tex')) void fs.readFile(uri.fsPath, 'utf8').then(text => this.sourceChanged(uri.fsPath, text)).catch(e => this.log(String(e)));
      }
    };
    watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed); this.resources.push(watcher);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Preparing the PDF, references, and live preview' }, async () => {
      await this.startSide('before', this.root, path.relative(this.root, this.main));
      if (this.task) await this.refreshReview(this.task.mode === 'workspace');
      for (const doc of vscode.workspace.textDocuments) if (doc.isDirty && inside(this.root, doc.uri.fsPath) && !inside(path.join(this.root, '.pdf-local-copilot'), doc.uri.fsPath)) this.before!.update(doc.uri.fsPath, doc.getText());
      this.scheduleAnchors();
    });
    if (!restoring) this.showChat(true); await this.saveConversation();
  }
  private async adoptWorkspaceTask() {
    const previous = this.conversation.value.task || this.task;
    if (previous && previous.mode !== 'workspace') {
      const review = await loadReview(previous) || makeReview(await changes(previous));
      const additional = (await changes(previous)).filter(change => {
        const stored = review.files.find(file => file.file === change.file), expected = stored && materialize(stored, edit => edit.decision !== 'rejected');
        return !stored || (expected ? !change.after?.equals(expected) : change.after !== undefined);
      }).map(change => ({ file: change.file, before: change.before?.toString('base64'), after: change.after?.toString('base64') }));
      const file = path.join(this.root, '.pdf-local-copilot', 'archives', previous.id + '.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const opened = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && inside(previous.dir, doc.uri.fsPath));
      const unsaved = opened.filter(doc => doc.isDirty).map(doc => ({ file: path.relative(previous.dir, doc.uri.fsPath), text: doc.getText() }));
      await fs.writeFile(file, JSON.stringify({ task: { id: previous.id, main: previous.main, sessions: previous.sessions }, review, additional, unsaved }, null, 2));
      const migrated = await WorkingTree.create(this.root, this.main, previous.sessions);
      this.conversation.value.task = migrated.task; this.task = undefined; this.workingTree = undefined;
      this.conversation.value.contextUpdates.push(`The working directory is now the live project ${this.root}. The current files are the working draft. The previous proposal is archived at ${file}. Read and edit the current project files for subsequent tasks.`);
      this.conversation.value.messages.push({ id: randomUUID(), role: 'system', text: 'The agent now edits the live project. Earlier proposals are archived by changed file; the source, PDF, and agent share the current working draft.' });
      for (const note of this.notes) {
        if (note.proposalTask && note.source) try {
          const from = this.proposalVersions.get(note.source.file) || await fs.readFile(path.join(previous.proposal, note.source.file), 'utf8');
          trackNotes([note], note.source.file, from, await fs.readFile(path.join(this.root, note.source.file), 'utf8'));
        } catch { note.anchorStatus = 'orphaned'; }
        delete note.proposalTask;
      }
      this.proposalVersions.clear();
      await this.context.workspaceState.update(this.key, undefined); await this.saveNotes(); await this.conversation.save();
      const inputs = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputCustom || tab.input instanceof vscode.TabInputNotebook ? [tab.input.uri] : tab.input instanceof vscode.TabInputTextDiff || tab.input instanceof vscode.TabInputNotebookDiff ? [tab.input.original, tab.input.modified] : [];
      for (const group of vscode.window.tabGroups.all) for (const tab of [...group.tabs]) {
        const uris = inputs(tab).filter(uri => uri.scheme === 'file' && inside(previous.dir, uri.fsPath));
        if (!uris.length || tab.isDirty || opened.some(doc => doc.isDirty && uris.some(uri => uri.toString() === doc.uri.toString()))) continue;
        const old = uris.find(uri => inside(previous.proposal, uri.fsPath));
        if (old) {
          const current = path.join(this.root, path.relative(previous.proposal, old.fsPath));
          try { await fs.access(current); await vscode.window.showTextDocument(vscode.Uri.file(current), { viewColumn: group.viewColumn, preserveFocus: true, preview: false }); } catch {}
        }
        await vscode.window.tabGroups.close(tab, true);
      }
      const retained = vscode.window.tabGroups.all.some(group => group.tabs.some(tab => inputs(tab).some(uri => uri.scheme === 'file' && inside(previous.dir, uri.fsPath)))) || opened.some(doc => doc.isDirty);
      if (!retained && path.dirname(previous.dir) === path.join(this.context.globalStorageUri.fsPath, 'tasks') && path.basename(previous.dir) === previous.id) await fs.rm(previous.dir, { recursive: true, force: true });
    } else if (previous) {
      const messages = this.conversation.value.messages;
      const lastEnd = messages.map(message => message.role === 'system' && message.text.startsWith('Review complete;')).lastIndexOf(true);
      const lastTurn = messages.map(message => message.role === 'user' || message.role === 'assistant').lastIndexOf(true);
      const ended = previous.ended ?? (lastEnd > lastTurn);
      if (!ended) { this.task = previous; this.workingTree = await WorkingTree.open(previous); }
      else { this.task = undefined; this.workingTree = undefined; await this.context.workspaceState.update(this.key, undefined); }
    }
    if (this.task?.mode === 'workspace' && this.task.startCommit === undefined) {
      this.task.startCommit = await gitHead(this.root) || null; this.task.reviewCommit = this.task.startCommit || undefined;
      await fs.writeFile(path.join(this.task.dir, 'task.json'), JSON.stringify(this.task, null, 2));
    }
    if (this.lastApplication && !inside(path.join(this.root, '.pdf-local-copilot'), this.lastApplication)) {
      const local = path.join(this.root, '.pdf-local-copilot', 'applications', path.basename(this.lastApplication));
      await fs.mkdir(path.dirname(local), { recursive: true }); await fs.copyFile(this.lastApplication, local); this.lastApplication = local;
      await this.context.workspaceState.update(`undo:${this.root}`, local);
    }
  }
  private async startSide(side: 'before' | 'after', root: string, relativeMain: string) {
    const oldPreview = side === 'before' ? this.before : this.after, oldBuild = side === 'before' ? this.beforeBuild : this.afterBuild;
    await oldPreview?.stop(); await oldBuild?.stop();
    const main = path.join(root, relativeMain), engine = await engineFor(main);
    const steps = this.configuration.get<BuildStep[]>('buildSteps', []).map(step => ({ command: step.command, args: step.args.map(a => a.replaceAll('${workspaceFolder}', root)) }));
    const build = new BuildManager(root, main, engine, text => this.log(text), steps);
    if (side === 'before') this.beforeBuild = build; else this.afterBuild = build;
    let pdf: string | undefined;
    try { await this.buildNow(build); pdf = engine === 'xelatex' ? undefined : build.pdf; }
    catch (e) { if (engine !== 'xelatex') throw e; this.log(`The initial full build failed. TeXpresso will display the content it can render. ${String(e)}\n`); }
    const preview = this.createPreview(side, root, main, build, pdf);
    if (side === 'before') this.before = preview; else this.after = preview;
    await preview.start(); preview.showPage(this.page);
  }
  private createPreview(side: 'before' | 'after', root: string, main: string, build: BuildManager, pdf?: string) {
    const session = ++this.previewSessions[side]; this.both({ type: 'previewReset', side, session });
    return new LivePreview(this.binary(), root, main, {
      frame: frame => { this.postFrame(this.panel, 'frame', side, session, frame); this.postFrame(this.proposalPanel, 'frame', side, session, frame); this.scheduleMarkers(side, session, frame.header.sequence, frame.header.revision); },
      state: value => {
        const previous = this.totals[side]; this.both({ type: 'previewState', side, session, ...value });
        this.totals[side] = { pages: value.pages, complete: value.complete }; this.pageCount = this.task ? Math.max(this.totals.before.pages, this.totals.after.pages) : value.pages;
        this.complete = this.totals.before.complete && (!this.task || this.task.mode === 'workspace' || this.totals.after.complete); this.ui.refresh();
        if (side === 'before' && value.complete && (!previous.complete || previous.pages !== value.pages)) this.scheduleAnchors();
        this.scheduleMarkers(side, session, value.sequence, value.revision);
      },
      log: text => this.log(`[${side}] ${text}`), error: e => { this.log(e.message + '\n'); this.both({ type: 'error', message: e.message }); }
    }, { includeDirectories: [build.directory], pdf });
  }
  private async buildNow(build: BuildManager) {
    try { const result = await build.build(); for (const file of this.diagnosticFiles) this.ui.diagnostics.delete(vscode.Uri.file(file)); this.diagnosticFiles.clear(); return result; }
    catch (e) {
      const output = (e as { output?: string }).output || ''; const grouped = new Map<string, vscode.Diagnostic[]>();
      for (const problem of parseProblems(output, path.dirname(build.main))) {
        const list = grouped.get(problem.file) || []; list.push(new vscode.Diagnostic(new vscode.Range(Math.max(0, problem.line - 1), 0, Math.max(0, problem.line - 1), 1000), problem.message, vscode.DiagnosticSeverity.Error)); grouped.set(problem.file, list);
      }
      for (const [file, list] of grouped) { this.ui.diagnostics.set(vscode.Uri.file(file), list); this.diagnosticFiles.add(file); } throw e;
    }
  }
  private scheduleBuild(side: 'before' | 'after') {
    clearTimeout(this.buildTimers.get(side));
    this.buildTimers.set(side, setTimeout(() => { if (!this.disposed) void this.rebuild(side, false).catch(e => this.log(String(e) + '\n')); }, 800));
  }
  async rebuild(side: 'before' | 'after' = this.currentSide, notify = true) {
    const build = side === 'before' ? this.beforeBuild : this.afterBuild, preview = side === 'before' ? this.before : this.after;
    if (!build) return; preview?.buildPending(true); await this.buildNow(build); preview?.buildPending(false); preview?.rescan();
    if (side === 'before' && !this.task) this.scheduleAnchors();
    if (notify) vscode.window.setStatusBarMessage('Paper and bibliography built.', 5000);
  }
  private watchProposal() {
    this.proposalWatcher?.dispose(); if (!this.task || this.task.mode === 'workspace') return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(this.task.proposal), '**/*'));
    const changed = (uri: vscode.Uri) => {
      if (!uri.fsPath.includes(`${path.sep}.pdf-local-copilot${path.sep}`) && inputFile(uri.fsPath)) {
        this.after?.rescan(); this.scheduleBuild('after');
        if (this.task && uri.fsPath.endsWith('.tex')) {
          const relative = path.relative(this.task.proposal, uri.fsPath);
          void fs.readFile(uri.fsPath, 'utf8').then(async text => {
            const before = this.proposalVersions.get(relative); this.proposalVersions.set(relative, text);
            if (before !== undefined && trackNotes(this.notes.filter(n => n.proposalTask === this.task?.id), relative, before, text)) await this.saveNotes();
          }).catch(e => this.log(String(e)));
        }
      }
    };
    watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed); this.proposalWatcher = watcher;
  }
  private async loadVersions() {
    for (const relative of new Set(this.notes.flatMap(n => n.source ? [n.source.file] : []))) {
      const file = path.resolve(this.root, relative); if (inside(this.root, file)) try {
        const text = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file)?.getText() ?? await fs.readFile(file, 'utf8'), before = this.versions.get(relative); if (before !== undefined && (!this.task || this.task.mode === 'workspace')) trackNotes(this.notes, relative, before, text); this.versions.set(relative, text);
      } catch { this.notes.filter(n => n.source?.file === relative).forEach(n => { n.anchorStatus = 'orphaned'; }); }
    }
  }
  private async sourceChanged(file: string, text: string) {
    this.sourceGeneration++;
    const relative = path.relative(this.root, file), previous = this.versions.get(relative); this.versions.set(relative, text);
    if (previous !== undefined && trackNotes(this.notes, relative, previous, text)) await this.saveNotes();
    this.scheduleAnchors();
  }
  private scheduleAnchors() { clearTimeout(this.anchorTimer); this.anchorTimer = setTimeout(() => { void this.refreshAnchors().catch(e => this.log(String(e))); }, 500); }
  private async watchHistoryGit() {
    const extension = vscode.extensions.getExtension('vscode.git'); if (!extension) return;
    type Repository = { rootUri: vscode.Uri; state: { HEAD?: { commit?: string }; onDidChange: vscode.Event<void> } };
    const api = (await extension.activate()).getAPI(1) as { repositories: Repository[]; onDidOpenRepository: vscode.Event<Repository> };
    if (this.disposed) return;
    const watched = new Set<Repository>();
    const attach = (repository: Repository) => {
      if (!inside(repository.rootUri.fsPath, this.root) || watched.has(repository)) return;
      watched.add(repository); const changed = () => {
        const head = repository.state.HEAD?.commit;
        if (head !== this.localHistory?.head || this.task && head !== this.task.reviewCommit) void this.refreshHistory().then(() => this.syncCommittedReview()).catch(this.ui.report);
      };
      this.resources.push(repository.state.onDidChange(changed)); changed();
    };
    for (const repository of api.repositories) attach(repository);
    this.resources.push(api.onDidOpenRepository(attach));
  }
  async refreshHistory() {
    await this.localHistory?.refresh();
    if (this.disposed) return;
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== 'pdfLocal.history' || input.original.path.split('/')[1] === this.localHistory?.head && this.localHistory.points.some(point => point.id === input.original.path.split('/')[2])) return false;
      try { const scope = JSON.parse(input.original.query); return scope.root === this.root && scope.main === path.relative(this.root, this.main); } catch { return false; }
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    this.ui.refresh();
  }
  private syncCommittedReview(force = false): Promise<void> {
    const next = this.decisions.catch(() => {}).then(async () => {
      const task = this.task, review = this.review;
      if (this.disposed || this.busy || task?.mode !== 'workspace' || task.ended || !review) return;
      const head = await gitHead(this.root); if (!head || !force && head === task.reviewCommit) return;
      if (head !== this.localHistory?.head) await this.refreshHistory();
      const committed = await committedReviewFiles(this.root, task.startCommit || undefined, head, review.files.map(file => file.file));
      const result = acceptCommittedReview(review, committed);
      if (this.disposed || this.busy || this.task !== task || this.review !== review) return;
      if (result.accepted) { await saveReview(task, result.review); this.review = result.review; }
      task.reviewCommit = head; await fs.writeFile(path.join(task.dir, 'task.json'), JSON.stringify(task, null, 2));
      if (result.accepted) {
        await this.publishReviewDecisions([...committed.keys()]); await this.paintMarkers();
        this.log(`Accepted ${result.accepted} committed changes from ${head.slice(0, 7)}.\n`);
      } else await this.conversation.save();
    });
    this.decisions = next; return next;
  }
  async showLocalHistory(point: HistoryPoint, file: string) {
    const history = this.localHistory; if (!history?.head) return;
    const left = historyUri(this.root, history.main, history.head, point.id, 'before', file), right = historyUri(this.root, history.main, history.head, point.id, 'after', file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `Local History · ${file} · ${displayHistoryLabel(point.label)}`, { viewColumn: this.sourceColumn(this.main), preview: true });
  }
  private async refreshAnchors() {
    if (this.anchoring || this.task && this.task.mode !== 'workspace' || this.busy || !this.before || this.disposed) return;
    this.anchoring = true;
    const generation = this.sourceGeneration;
    const pages = new Map<number, Promise<Frame>>();
    const readPage = (page: number) => { if (!pages.has(page)) pages.set(page, this.before!.readPage(page)); return pages.get(page)!; };
    try {
      for (const note of this.notes) {
        if (!note.source) continue;
        const file = path.resolve(this.root, note.source.file);
        if (!inside(this.root, file)) { note.anchorStatus = 'orphaned'; continue; }
        try { await fs.access(file); } catch { note.anchorStatus = 'orphaned'; continue; }
        try {
          let point: PagePoint | undefined;
          try { point = await this.before.position(path.join(this.root, note.source.file), note.source.line); } catch (e) { this.log(`Annotation source location: ${String(e)}\n`); }
          const location = await locateAnnotation(note, point, this.before.snapshot().pages, readPage);
          if (generation !== this.sourceGeneration) break;
          if (location) { note.page = location.page; note.rects = location.rects; if (note.anchorStatus === 'orphaned') note.anchorStatus = 'anchored'; }
          else note.anchorStatus = 'orphaned';
        } catch (e) { this.log(`Annotation tracking: ${String(e)}\n`); }
      }
      if (this.notes.length) await this.saveNotes();
    } finally { this.anchoring = false; if (generation !== this.sourceGeneration) this.scheduleAnchors(); }
  }
  private syncComments() {
    this.threads.forEach(t => t.dispose()); this.threads = [];
    for (const note of this.notes) {
      if (note.status && note.status !== 'open') continue;
      if (!note.source) continue; const file = path.resolve(this.root, note.source.file); if (!inside(this.root, file)) continue;
      const line = Math.max(0, note.source.line - 1), body = new vscode.MarkdownString().appendText(note.comment);
      if (note.quote) body.appendMarkdown('\n\n').appendText(`“${note.quote}”`);
      const thread = this.comments.createCommentThread(vscode.Uri.file(file), new vscode.Range(line, 0, line, 0), [{ body, mode: vscode.CommentMode.Preview, author: { name: `PDF Page ${note.page + 1}` } }]);
      thread.label = 'PDF Annotations'; thread.canReply = false; thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed; this.threads.push(thread);
    }
  }
  private async saveNotes() {
    const content = JSON.stringify({ version: 2, main: path.relative(this.root, this.main), notes: this.notes, sources: Object.fromEntries(this.versions), proposalSources: Object.fromEntries(this.proposalVersions) }, null, 2);
    this.noteWrites = this.noteWrites.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.noteFile), { recursive: true }); await fs.writeFile(this.noteFile + '.tmp', content); await fs.rename(this.noteFile + '.tmp', this.noteFile);
      if (!this.disposed) { this.both({ type: 'notes', notes: this.notes }); this.both({ type: 'chatState', ...this.chatState() }); this.ui.refresh(); }
    });
    return this.noteWrites;
  }
  private async annotate(m: { header: FrameHeader; rects: number[][]; quote: string; comment: string; draftId: string; session: number; kind?: string; runAfterSave?: boolean }, side: 'before' | 'after') {
    if (typeof m.quote !== 'string' || m.quote.length > 50000 || !Array.isArray(m.rects) || !m.rects.length || m.rects.length > 500 || !m.rects.every(r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1])) throw new Error('Invalid annotation geometry.');
    if (typeof m.comment !== 'string' || !m.comment.trim() || m.comment.length > 20000) throw new Error('Enter an annotation of up to 20,000 characters.');
    const preview = side === 'before' ? this.before : this.after;
    if (!preview || !m.header || m.session !== this.previewSessions[side]) throw new Error('The page has changed. Select this passage again.');
    const current = await preview.activatePage(m.header.page);
    const samePage = JSON.stringify(m.header.characters) === JSON.stringify(current.characters);
    const matched = m.kind === 'region' ? undefined : quoteGeometry(current, m.quote, m.rects[0]);
    if (m.header.sequence !== current.sequence && !samePage && !matched) throw new Error('The selected passage has changed. Keep the annotation text and select the source passage again.');
    const rects = matched || m.rects;
    m.rects = rects;
    let source: Note['source']; try { source = await preview.source(current, m.rects, m.quote); } catch (e) { this.log(String(e)); }
    if (source) try {
      const file = path.join(preview.root, source.file), text = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file)?.getText() ?? await fs.readFile(file, 'utf8');
      const locate = (rect: number[]) => {
        const point = nearestTextPoint(current.characters || [], (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2);
        return refineSourceLocation(text, source!.line, 0, undefined, point && textContext(current.characters || [], ...point));
      };
      const first = locate(m.rects[0]), last = locate(m.rects[m.rects.length - 1]);
      if (first.length) {
        source.line = first.line + 1; source.endLine = last.length ? Math.max(source.line, last.line + 1) : source.line;
        source.text = text.split(/\r?\n/).slice(Math.max(0, source.line - 3), source.endLine + 2).join('\n');
      }
    } catch (e) { this.log(`Annotation source validation: ${String(e)}\n`); }
    const rectangle = [Math.min(...m.rects.map(r => r[0])), Math.min(...m.rects.map(r => r[1])), Math.max(...m.rects.map(r => r[2])), Math.max(...m.rects.map(r => r[3]))];
    const image = await preview.capture(m.header.page, rectangle);
    const note: Note = { id: randomUUID(), number: Math.max(0, ...this.notes.map((note, index) => note.number || index + 1)) + 1, page: m.header.page, quote: m.quote.trim(), comment: m.comment.trim(), rects: m.rects, source, anchorStatus: 'anchored', proposalTask: side === 'after' ? this.task?.id : undefined };
    if (source && m.kind === 'region') try {
      const point = await preview.position(path.join(preview.root, source.file), source.line);
      note.region = { dx: rectangle[0] - point.x, dy: rectangle[1] - point.y, width: rectangle[2] - rectangle[0], height: rectangle[3] - rectangle[1] };
    } catch (e) { this.log(`Selection anchor: ${String(e)}\n`); }
    if (source) {
      const sourceRoot = side === 'after' && this.task ? this.task.proposal : this.task?.mode === 'workspace' ? this.root : this.task?.baseline || this.root;
      try { const file = path.join(sourceRoot, source.file), text = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === file)?.getText() ?? await fs.readFile(file, 'utf8'); source.anchor = text.split(/\r?\n/).slice(source.line - 1, source.endLine || source.line).join('\n'); if (!this.task || this.task.mode === 'workspace') this.versions.set(source.file, text); else if (side === 'after') this.proposalVersions.set(source.file, text); } catch {}
    }
    if (image) { const file = path.join(this.root, '.pdf-local-copilot', 'images', note.id + '.png'); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, image.bytes); note.image = path.relative(this.root, file); }
    this.notes.push(note); await this.saveNotes();
    this.post(this.panelFor(side), { type: 'annotationSaved', draftId: m.draftId, id: note.id });
    if (m.runAfterSave) await this.sendNote(note.id);
  }
  private async sendNote(id: string) {
    const note = this.notes.find(note => note.id === id); if (!note) return;
    const conversation = this.conversation.value;
    if ([...(conversation.activeTurn ? [conversation.activeTurn] : []), ...conversation.queue].some(turn => turn.notes.some(sent => sent.id === id && sent.comment === note.comment))) return;
    await this.showChatForAction(true); await this.sendChat('', conversation.agent, [id], conversation.runOptions);
  }
  selectNote(id: string, checked: boolean) { checked ? this.selectedNotes.add(id) : this.selectedNotes.delete(id); if (checked && !this.chatPanel) void this.showChatForAction(true).catch(this.ui.report); this.conversation.value.selectedNotes = [...this.selectedNotes]; void this.saveConversation().catch(this.ui.report); this.ui.refresh(); }
  selectReviewEdits(id: string, selected: boolean, wholeFile = false) {
    const edits = (wholeFile ? this.review?.files.find(file => file.file === id)?.edits : this.review?.files.flatMap(file => file.edits).filter(edit => edit.id === id)) || [];
    for (const edit of edits) if (edit.decision !== 'accepted') { if (selected) this.selectedEdits.add(edit.id); else this.selectedEdits.delete(edit.id); }
    this.conversation.value.selectedEdits = [...this.selectedEdits]; void this.conversation.save().catch(this.ui.report); this.ui.refresh();
  }
  async acceptSelectedEdits() {
    const ids = [...this.selectedEdits]; if (!ids.length) throw new Error('Select the changes to accept first.');
    const accepted: string[] = [];
    try { for (const id of ids) { await this.setDecision(id, 'accepted', false, false); accepted.push(id); } }
    finally { if (accepted.length) await this.recordAcceptance(accepted, `Accepted Changes · ${accepted.length} `); }
  }
  private async recordAcceptance(ids: string[], label: string) {
    const files = this.review?.files.filter(file => file.edits.some(edit => ids.includes(edit.id) && edit.decision === 'accepted')) || [];
    await this.localHistory?.approve(label, new Map(files.map(file => [file.file, materialize(file, edit => edit.decision === 'accepted')])));
    await this.refreshHistory();
  }
  async selectAllNotes() {
    this.selectedNotes = new Set(this.notes.filter(note => !note.status || note.status === 'open').map(note => note.id));
    this.conversation.value.selectedNotes = [...this.selectedNotes]; await this.saveConversation(); this.ui.refresh();
  }
  sendSelectedNotes() {
    const ids = [...this.selectedNotes].filter(id => this.notes.some(note => note.id === id));
    if (!ids.length) throw new Error('Select the annotations to send first.');
    this.pendingNoteSend = ids; void this.showChatForAction().then(() => this.flushChatActions()).catch(this.ui.report);
  }
  private flushChatActions() {
    if (!this.chatReady || !this.chatPanel?.active) return;
    if (this.pendingChatFocus) { this.post(this.chatPanel, { type: 'focusChat', ...this.pendingChatFocus }); this.pendingChatFocus = undefined; }
    if (this.pendingNoteSend) { this.post(this.chatPanel, { type: 'sendSelectedNotes', ids: this.pendingNoteSend }); this.pendingNoteSend = undefined; }
  }
  async notePopup(id: string) {
    const note = this.notes.find(n => n.id === id); if (!note) return;
    const action = await vscode.window.showQuickPick([{ label: '$(send) Send Task', value: 'run' }, { label: '$(edit) Edit Annotation', value: 'edit' }, { label: '$(go-to-file) Go to Source', value: 'source' }, { label: '$(trash) Delete Annotation', value: 'delete' }], { title: note.comment, ignoreFocusOut: true });
    if (action?.value === 'run') await this.sendNote(note.id); else if (action?.value === 'edit') await this.editNote(id); else if (action?.value === 'source') await this.showSource(note); else if (action?.value === 'delete') await this.deleteNote(id);
  }
  async editNote(id: string) {
    const note = this.notes.find(n => n.id === id); if (!note) return;
    await this.revealNote(note); this.post(this.panelFor(note.proposalTask ? 'after' : 'before'), { type: 'editNote', id });
  }
  private async updateNote(id: string, comment: unknown) {
    const note = this.notes.find(n => n.id === id); if (!note || typeof comment !== 'string' || !comment.trim() || comment.length > 20000) throw new Error('Enter valid annotation text.');
    note.comment = comment.trim(); note.status = 'open'; await this.saveNotes(); this.both({ type: 'noteEdited', id });
  }
  async deleteNote(id: string) { this.notes = this.notes.filter(n => n.id !== id); this.selectedNotes.delete(id); this.conversation.value.selectedNotes = [...this.selectedNotes]; await this.saveNotes(); await this.saveConversation(); }
  async showSource(note: Note) { if (!note.source) return; const file = path.resolve(this.root, note.source.file); if (!inside(this.root, file)) return; this.syncComments(); const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: this.sourceColumn(file) }); const position = new vscode.Position(Math.max(0, note.source.line - 1), 0); editor.selection = new vscode.Selection(position, position); editor.revealRange(new vscode.Range(position, position)); }
  async revealSource(file: string, line: number) {
    const proposal = !!this.task && this.task.mode !== 'workspace' && inside(this.task.proposal, file);
    const preview = proposal ? this.after : this.before;
    if (!preview) throw new Error('The PDF preview is starting. Please retry shortly.');
    let target = file;
    if (this.task && this.task.mode !== 'workspace' && !proposal && inside(this.root, file)) {
      target = path.join(this.task.baseline, path.relative(this.root, file));
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      line = mapLine(document.getText(), await fs.readFile(target, 'utf8'), line).line;
    }
    if (!inside(preview.root, target)) throw new Error('This source file does not belong to the current paper.');
    const point = await preview.position(target, line), frame = await preview.readPage(point.page);
    if (proposal) this.showProposal(); else this.showManuscript();
    this.page = point.page; preview.showPage(point.page);
    this.post(this.panel, { type: 'sourcePosition', side: proposal ? 'after' : 'before', page: point.page, rects: nearbyGeometry(frame.header, point.x, point.y) });
    this.ui.refresh();
  }
  async revealNote(note: Note) {
    if (!this.task) await this.refreshAnchors();
    const proposal = !!note.proposalTask && !!this.task && this.task.mode !== 'workspace'; if (proposal) this.showProposal(); else this.showManuscript();
    const panel = this.panel; panel.reveal(); this.currentSide = proposal ? 'after' : 'before';
    await this.showPage(note.page); this.post(panel, { type: 'reveal', page: note.page, rect: note.rects[0], noteId: note.id });
  }
  private chatState() {
    const conversation = this.conversation.value;
    return {
      agents: this.agentProfiles(), agentName: this.agentProfile(conversation.agent).name, catalogs: this.catalogs, runOptions: conversation.runOptions || {},
      messages: conversation.messages, queuedNotes: [...this.selectedNotes].map(id => this.notes.find(n => n.id === id)).filter((n): n is Note => !!n).map(n => ({ id: n.id, page: n.page, comment: n.comment })),
      tasks: conversation.queue.map(turn => ({ id: turn.id, text: turn.instruction, count: turn.notes.length })),
      active: conversation.activeTurn?.id, busy: this.queueActive, paused: conversation.paused, draft: conversation.draft, agent: conversation.agent,
      lockedAgent: conversation.messages.some(m => m.role === 'user') || !!conversation.task?.sessions?.[conversation.agent],
      hasTask: !!this.task, view: this.mainViewSide, direct: true, hasUndo: this.canUndo,
      canNew: !this.newSessionBlock()
    };
  }
  private agentProfiles() {
    const config = vscode.workspace.getConfiguration('pdfLocal', vscode.Uri.file(this.main));
    const profiles = configuredAgents(config.get<CustomAgent[]>('agents', []), { codex: config.get<string>('codexPath', 'codex'), claude: config.get<string>('claudePath', 'claude') });
    const bound = this.conversation.value.agentProfile;
    return bound ? [bound, ...profiles.filter(profile => profile.id !== bound.id)] : profiles;
  }
  private agentProfile(id: string): AgentProfile { return this.agentProfiles().find(profile => profile.id === id) || this.agentProfiles()[0]; }
  private async loadModels() { this.catalogs = Object.fromEntries(await Promise.all(this.agentProfiles().map(async profile => [profile.id, await modelCatalog(profile)]))); }
  private async chooseModel() {
    const model = await vscode.window.showInputBox({ title: 'Model Name', prompt: 'Enter a model name or alias supported by the local CLI', value: this.conversation.value.runOptions?.model || '' });
    if (model === undefined) return;
    this.conversation.value.runOptions = runOptions({ ...this.conversation.value.runOptions, model }, this.agentProfile(this.conversation.value.agent).type); await this.saveConversation();
  }
  async addClaudeAgent() {
    const name = await vscode.window.showInputBox({ title: 'Add Claude Agent', prompt: 'Agent display name', placeHolder: 'For example, uclaude', validateInput: value => !value.trim() ? 'Enter a name' : this.agentProfiles().some(profile => profile.name.toLowerCase() === value.trim().toLowerCase()) ? 'This name already exists' : undefined });
    if (!name) return;
    const directory = await vscode.window.showInputBox({ title: `Configure ${name.trim()}`, prompt: 'claude_config_dir: the Claude configuration directory for this agent', placeHolder: 'For example, ~/.claude-uni', validateInput: value => value.trim() ? undefined : 'Enter a configuration directory' });
    if (!directory) return;
    const config = vscode.workspace.getConfiguration('pdfLocal'), agents = config.get<CustomAgent[]>('agents', []);
    await config.update('agents', [...agents, { name: name.trim(), type: 'claude', claude_config_dir: directory.trim() }], vscode.ConfigurationTarget.Global);
    if (!this.chatState().lockedAgent) { this.conversation.value.agent = `custom:${name.trim()}`; this.conversation.value.runOptions = {}; }
    await this.loadModels();
    await this.saveConversation();
  }
  private async saveConversation() { this.both({ type: 'chatState', ...this.chatState() }); await this.conversation.save(); }
  private async sendChat(instruction: unknown, agent: unknown, ids: unknown, options?: unknown) {
    if (typeof instruction !== 'string' || instruction.length > 50000 || !Array.isArray(ids) || !ids.every(id => typeof id === 'string') || !this.agentProfiles().some(profile => profile.id === agent)) throw new Error('Invalid task content.');
    const conversation = this.conversation.value, chosen = agent as Agent;
    if (this.chatState().lockedAgent && chosen !== conversation.agent) throw new Error('The agent is bound to this conversation. Start a new session to switch agents.');
    const notes = [...new Set(ids)].map(id => this.notes.find(note => note.id === id)).filter((note): note is Note => !!note);
    if (!instruction.trim() && !notes.length) throw new Error('Enter a revision request or select PDF annotations to send.');
    conversation.agent = chosen; conversation.agentProfile ??= structuredClone(this.agentProfile(chosen)); await this.context.workspaceState.update('lastAgent', chosen);
    const selectedOptions = runOptions(options, this.agentProfile(chosen).type); conversation.runOptions = selectedOptions;
    const turn: QueuedTurn = { id: randomUUID(), assistantId: randomUUID(), agent: chosen, instruction: instruction.trim(), notes: structuredClone(notes), options: structuredClone(selectedOptions) };
    conversation.queue.push(turn);
    conversation.messages.push({ id: turn.id, role: 'user', text: turn.instruction || 'Revise the paper using these PDF annotations.', notes: notes.map(n => ({ id: n.id, page: n.page, comment: n.comment })), status: 'queued' });
    for (const note of notes) this.selectedNotes.delete(note.id); conversation.selectedNotes = [...this.selectedNotes];
    if (conversation.draft === instruction) conversation.draft = '';
    this.both({ type: 'chatSent', instruction }); await this.saveConversation(); this.ui.refresh(); this.startQueue();
  }
  private startQueue() {
    if (this.processingQueue || this.conversation.value.paused || this.disposed) return;
    this.draining = this.drainQueue().catch(e => { this.conversation.value.paused = true; this.log(String(e)); }).finally(() => {
      this.draining = undefined;
      if (!this.disposed && !this.conversation.value.paused && this.conversation.value.queue.length) this.startQueue();
    });
  }
  private async drainQueue() {
    this.processingQueue = true; this.ui.refresh();
    try {
      while (!this.disposed && !this.conversation.value.paused && this.conversation.value.queue.length) {
        const conversation = this.conversation.value, turn = conversation.queue.shift()!;
        conversation.activeTurn = turn;
        const user = conversation.messages.find(m => m.id === turn.id); if (user) user.status = 'running';
        const response = { id: turn.assistantId, role: 'assistant' as const, text: '', activities: [] as AgentActivity[], status: 'running' as 'running' | 'completed' | 'failed' };
        conversation.messages.push(response); await this.saveConversation();
        let outputTimer: NodeJS.Timeout | undefined;
        try {
          await this.executeTurn(turn.agent, turn.notes, turn.instruction, update => {
            response.text = update.text; response.activities = update.activities;
            if (!outputTimer) outputTimer = setTimeout(() => {
              outputTimer = undefined; this.both({ type: 'agentOutput', id: response.id, text: response.text, activities: response.activities });
              void this.conversation.save().catch(e => this.log(String(e)));
            }, 100);
          }, turn.options, turn.id);
          response.status = 'completed'; if (!response.text) response.text = 'This task is complete. Review its changes in the PDF.'; if (user) user.status = 'completed';
        } catch (e) {
          response.status = 'failed'; response.text += `\n${e instanceof Error ? e.message : String(e)}`; if (user) user.status = 'failed'; conversation.paused = true;
        }
        clearTimeout(outputTimer);
        conversation.activeTurn = undefined; await this.saveConversation();
      }
    } finally { this.processingQueue = false; await this.syncCommittedReview(); this.ui.refresh(); await this.saveConversation(); }
  }
  private newSessionBlock() {
    if (this.queueActive) return 'The agent is still running. Wait for completion or stop it before starting a new session.';
    if (this.conversation.value.queue.length) return 'There are queued tasks. Run or remove them before starting a new session.';
    if (this.selectedNotes.size) return 'There are annotations waiting to be sent. Send or remove them before starting a new session.';
    if (this.task && (!this.review || this.review.files.some(file => file.edits.some(edit => edit.decision === 'pending')))) return 'There are changes pending review. Accept, reject, or end the review before starting a new session.';
    return '';
  }
  async newSession() {
    const reason = this.newSessionBlock(); if (reason) throw new Error(reason);
    if (this.task) await this.finishTask();
    const options = this.conversation.value.runOptions;
    await this.conversation.reset(this.conversation.value.agent); this.conversation.value.runOptions = options; this.selectedNotes.clear(); await this.saveConversation(); this.ui.refresh();
    if (!this.agentProfiles().some(profile => profile.id === this.conversation.value.agent)) { this.conversation.value.agent = this.agentProfiles()[0].id; await this.saveConversation(); }
  }
  async revise(specific?: Note[], extra = '') {
    for (const note of specific || []) this.selectedNotes.add(note.id);
    if (extra && !this.conversation.value.draft.startsWith(extra)) this.conversation.value.draft = extra + this.conversation.value.draft;
    this.pendingChatFocus = extra ? { draft: this.conversation.value.draft } : {};
    this.conversation.value.selectedNotes = [...this.selectedNotes]; await this.saveConversation();
    await this.showChatForAction(); this.flushChatActions();
  }
  private async showChatForAction(preserveFocus = false) {
    if (this.chatPanel) { this.showChat(preserveFocus); return; }
    if (this.openingChat) return this.openingChat;
    this.openingChat = (async () => {
      const column = this.panel.viewColumn;
      if (column && vscode.window.tabGroups.all.some(group => group.viewColumn === column + 1)) {
        this.panel.reveal(undefined, false);
        await vscode.commands.executeCommand('workbench.action.newGroupRight');
      }
      if (this.disposed) return;
      this.showChat(preserveFocus);
      if (preserveFocus) this.panel.reveal(undefined, false);
    })().finally(() => { this.openingChat = undefined; });
    return this.openingChat;
  }
  private showChat(preserveFocus = false) {
    if (this.chatPanel) { this.chatPanel.reveal(undefined, preserveFocus); return; }
    const panel = this.chatPanel = this.createPanel('chat', this.panel.viewColumn ? this.panel.viewColumn + 1 : vscode.ViewColumn.Beside, undefined, preserveFocus);
    panel.onDidDispose(() => { if (this.chatPanel === panel) { this.chatPanel = undefined; this.chatReady = false; } });
  }
  private async executeTurn(chosen: Agent, selected: Note[], instruction: string, assistant: (update: AgentUpdate) => void, options: RunOptions = {}, requestId: string = randomUUID()) {
    const profile = this.agentProfile(chosen), agent = { value: chosen, label: profile.name };
    this.busy = true; this.ui.refresh();
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `${agent.label} · ${this.task?.sessions?.[agent.value] ? 'Continue Session' : 'Revise Paper'}` }, async (progress, token) => {
      let request: ReviewRequest | undefined;
      let succeeded = false;
      const cancellation = token.onCancellationRequested(() => { this.conversation.value.paused = true; void this.saveConversation(); void this.run?.stop(); });
      try {
        for (const doc of vscode.workspace.textDocuments) if (doc.isDirty && doc.uri.scheme === 'file' && inside(this.root, doc.uri.fsPath) && !inside(path.join(this.root, '.pdf-local-copilot'), doc.uri.fsPath) && !await doc.save()) throw new Error(`Save ${doc.fileName} first`);
        if (this.task?.mode === 'workspace') {
          const decisions = this.review?.files.flatMap(file => file.edits.filter(edit => edit.decision !== 'pending').map(edit => `${edit.decision}: ${file.file}:${edit.beforeLine} ${JSON.stringify(edit.removed)} -> ${JSON.stringify(edit.inserted)}`)).join('\n');
          if (decisions) this.conversation.value.contextUpdates.push(`Previous review decisions: \n${decisions}`);
          await this.finishTask(true);
        }
        if (!this.task) {
          progress.report({ message: 'Recording the working draft…' });
          this.workingTree = await WorkingTree.create(this.root, this.main, this.conversation.value.task?.sessions);
          this.task = this.workingTree.task; this.conversation.value.task = this.task;
          this.task.startCommit = await gitHead(this.root) || null; this.task.reviewCommit = this.task.startCommit || undefined; this.task.ended = false;
          await fs.writeFile(path.join(this.task.dir, 'task.json'), JSON.stringify(this.task, null, 2));
          await this.saveConversation(); await this.context.workspaceState.update(this.key, this.task);
        }
        await this.workingTree?.capture();
        request = { id: requestId, instruction, notes: structuredClone(selected), anchors: [] };
        for (const note of selected) if (note.source) {
          const original = this.workingTree?.original(note.source.file), current = await fs.readFile(path.join(this.root, note.source.file), 'utf8').catch(() => '');
          request.anchors.push({ noteId: note.id, file: note.source.file, line: original ? mapLine(current, original.toString('utf8'), note.source.line).line : note.source.line, endLine: original ? mapLine(current, original.toString('utf8'), note.source.endLine || note.source.line).line : note.source.endLine || note.source.line });
        }
        this.review ??= { version: 1, files: [] }; this.review.requests ??= []; this.review.requests.push(request); await saveReview(this.task, this.review);
        if (token.isCancellationRequested || this.conversation.value.paused || this.disposed) throw new Error('The task was cancelled and the queue is paused.');
        const images: string[] = []; let imageBytes = 0;
        for (const note of selected) if (note.image) {
          const source = path.resolve(this.root, note.image); if (!inside(this.root, source)) throw new Error('The image path is outside the current paper project.');
          const bytes = await fs.readFile(source); imageBytes += bytes.length;
          if (imageBytes > 6 * 1024 * 1024) throw new Error('The selected PDF screenshots exceed 6 MiB. Send the annotations in smaller batches.');
          const target = path.join(this.task.dir, 'images', note.id + '.png'); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); images.push(target);
        }
        this.showProposal(true); this.both({ type: 'hasTask', value: true }); this.ui.refresh();
        const feedback = this.review?.files.flatMap(f => f.edits.filter(e => e.decision !== 'pending').map(e => `${e.decision}: ${f.file}:${e.beforeLine} ${JSON.stringify(e.removed)} -> ${JSON.stringify(e.inserted)}`)).join('\n') || '';
        this.log(`\n=== ${agent.label} · ${this.task.id} · ${images.length} images ===\n`);
        this.run = runAgent(agent.value, profile.command, this.task, selected, `${instruction}\n\nCurrent manuscript updates:\n${this.conversation.value.contextUpdates.join('\n')}\n\nAuthor's prior review decisions:\n${feedback}`, s => this.log(s), images, assistant, profile, options);
        progress.report({ message: 'Reading annotations and screenshots, and editing source files.' }); await this.run.done; succeeded = true;
        this.conversation.value.task = this.task; this.conversation.value.contextUpdates = []; await this.saveConversation();
        await this.context.workspaceState.update(this.key, this.task);
        clearTimeout(this.buildTimers.get(this.task?.mode === 'workspace' ? 'before' : 'after')); progress.report({ message: 'Updating the bibliography, PDF, and review markers…' });
        try { await this.rebuild(this.task?.mode === 'workspace' ? 'before' : 'after', false); } catch (e) { this.log(`This round did not build successfully: ${String(e)}\n`); }
      } finally {
        cancellation.dispose(); this.run = undefined; this.busy = false;
        if (!this.disposed) { this.before?.rescan(); await this.workingTree?.capture(); await this.refreshReview(true, request); if (succeeded && request) await this.hideProcessedNotes([request]); await this.refreshAnchors(); this.ui.refresh(); }
      }
    });
    if (!this.disposed) vscode.window.setStatusBarMessage('Changes are ready. Click numbered PDF markers to review them.', 5000);
  }
  async stopAgent() { this.conversation.value.paused = true; await this.saveConversation(); await this.run?.stop(); }
  showManuscript(preserveFocus = false) {
    this.proposalPanel?.dispose(); this.proposalPanel = undefined; this.mainViewSide = 'before'; this.currentSide = 'before';
    this.panel.title = `Paper · ${path.basename(this.main)}`; this.syncPanel(this.panel, 'before'); this.panel.reveal(undefined, preserveFocus);
  }
  showProposal(preserveFocus = false) {
    if (!this.task) return;
    if (this.task.mode === 'workspace') { this.showManuscript(preserveFocus); return; }
    this.proposalPanel?.dispose(); this.proposalPanel = undefined; this.mainViewSide = 'after'; this.currentSide = 'after';
    this.panel.title = `Working Draft · ${path.basename(this.main)}`; this.syncPanel(this.panel, 'after'); this.panel.reveal(undefined, preserveFocus);
  }
  async compare() {
    if (this.task?.mode === 'workspace') {
      const file = this.review?.files.find(file => file.file === this.task?.main) || this.review?.files[0];
      if (file) await this.diff(file.file); else vscode.window.setStatusBarMessage('The current working draft has no changes pending review.', 4000);
      return;
    }
    if (!this.task) return; this.mainViewSide = 'before'; this.currentSide = 'before'; this.panel.title = `Original · ${path.basename(this.main)}`; this.panel.reveal();
    if (!this.proposalPanel) { this.proposalPanel = this.createPanel('after', vscode.ViewColumn.Beside); this.proposalPanel.onDidDispose(() => { this.proposalPanel = undefined; }); }
    else this.proposalPanel.reveal(vscode.ViewColumn.Beside);
    this.syncPanel(this.panel, 'before'); this.syncPanel(this.proposalPanel, 'after');
  }
  async refreshReview(regenerate = true, request?: ReviewRequest) {
    if (!this.task) { this.review = undefined; this.markers = { before: [], after: [] }; this.both({ type: 'markers', markers: this.markers }); this.ui.refresh(); return; }
    await this.workingTree?.capture();
    const previous = this.review || await loadReview(this.task);
    this.review = !regenerate && previous ? previous : makeReview(await changes(this.task), previous);
    associateReview(this.review, previous, request);
    const visible = new Set(this.review.files.flatMap(file => file.edits.filter(edit => edit.decision !== 'accepted').map(edit => edit.id)));
    this.selectedEdits = new Set([...this.selectedEdits].filter(id => visible.has(id))); this.conversation.value.selectedEdits = [...this.selectedEdits];
    await this.hideProcessedNotes((this.review.requests || []).filter(request => this.conversation.value.messages.some(message => message.id === request.id && message.status === 'completed')));
    for (const file of this.review.files) if (!file.binary) this.ui.reviewBase.set(this.task.id, file.file, materialize(file, edit => edit.decision === 'accepted')?.toString('utf8') || '', this.root);
    await saveReview(this.task, this.review); this.both({ type: 'hasTask', value: true }); this.ui.refresh(); await this.paintMarkers();
    if (this.after) {
      for (const note of this.notes.filter(n => n.proposalTask === this.task?.id && n.source)) try {
        const point = await this.after.position(path.join(this.task.proposal, note.source!.file), note.source!.line), frame = await this.after.readPage(point.page);
        note.page = point.page; note.rects = regionGeometry(frame.header, note, point.x, point.y) || quoteGeometry(frame.header, note.quote, [point.x, point.y]) || nearbyGeometry(frame.header, point.x, point.y);
      } catch (e) { this.log(String(e)); }
      if (this.notes.some(n => n.proposalTask)) await this.saveNotes();
    }
    await this.syncCommittedReview(true);
  }
  private async hideProcessedNotes(requests: ReviewRequest[]) {
    let changed = false;
    for (const request of requests) for (const snapshot of request.notes) {
      const note = this.notes.find(note => note.id === snapshot.id);
      if (note && (!note.status || note.status === 'open') && note.comment === snapshot.comment) { note.status = 'reviewing'; changed = true; }
    }
    if (changed) await this.saveNotes();
  }
  private async paintMarkers() {
    if (this.disposed || !this.review || !this.task || !this.before || this.task.mode !== 'workspace' && !this.after || this.busy) return;
    const generation = ++this.markerGeneration;
    const review = this.review, task = this.task, markers: { before: Marker[]; after: Marker[] } = { before: [], after: [] };
    for (const side of (task.mode === 'workspace' ? ['before'] : ['before', 'after']) as ('before' | 'after')[]) {
      const preview = side === 'before' ? this.before : this.after; if (!preview) continue;
      const files = review.files.filter(file => file.file.toLowerCase().endsWith('.tex') && file.edits.some(edit => edit.decision !== 'accepted'));
      if (!files.length) continue;
      const deadline = Date.now() + 20000;
      while (!preview.snapshot().complete && Date.now() < deadline) {
        if (this.disposed || this.review !== review || this.task !== task || generation !== this.markerGeneration) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const headers: FrameHeader[] = [];
      for (let page = 0; page < preview.snapshot().pages; page++) {
        if (this.disposed || this.review !== review || this.task !== task || generation !== this.markerGeneration) return;
        try { headers.push((await preview.readPage(page)).header); } catch (e) { this.log(`Reading changed pages: ${String(e)}\n`); }
      }
      for (const file of files) {
        const original = side === 'before' && task.mode !== 'workspace';
        const source = original ? Buffer.from(file.before || '', 'base64').toString('utf8') : materialize(file, edit => edit.decision !== 'rejected')?.toString('utf8') || '';
        const locate = alignReviewSource(source, headers);
        for (const edit of file.edits.filter(edit => edit.decision !== 'accepted')) {
          const offset = original ? edit.start : editPosition(file, edit).offset;
          const length = original || edit.decision === 'rejected' ? edit.removed.length : edit.inserted.length;
          const notes = review.requests?.find(request => request.id === edit.requestId)?.notes.filter(note => edit.noteIds?.includes(note.id)) || [];
          const originLabel = notes.length ? notes.map(note => `Annotation ${note.number || ''}`).join(', ') : edit.origin === 'annotation' ? 'Annotations' : edit.origin === 'session' ? 'From Conversation' : 'From Editor';
          const ranges = locate(offset, length), common = { id: edit.id, decision: edit.decision, label: `${file.file}:${edit.beforeLine}`, originLabel };
          if (ranges.length) for (const range of ranges) markers[side].push({ ...common, ...range });
          else markers[side].push({ ...common, page: 0, rects: [[22, 18 + markers[side].filter(marker => marker.unresolved).length * 18, 44, 33 + markers[side].filter(marker => marker.unresolved).length * 18]], unresolved: true });
        }
      }
    }
    if (this.disposed || this.review !== review || this.task !== task || generation !== this.markerGeneration) return;
    this.markers = markers; this.both({ type: 'markers', markers }); this.ui.refresh();
  }
  private scheduleMarkers(side: 'before' | 'after', session: number, sequence: number, revision: number) {
    if (this.disposed || this.busy || !this.totals[side].complete || !this.review?.files.some(file => file.file.endsWith('.tex') && file.edits.some(edit => edit.decision !== 'accepted'))) return;
    const version = `${session}:${sequence}:${revision}`;
    if (this.markerVersions.get(side) === version) return;
    this.markerVersions.set(side, version); clearTimeout(this.markerTimer);
    this.markerTimer = setTimeout(() => { void this.paintMarkers().catch(error => this.log(String(error))); }, 100);
  }
  setDecision(id: string, decision: Decision, wholeFile = false, recordHistory = true): Promise<void> {
    const next = this.decisions.catch(() => {}).then(() => this.changeDecision(id, decision, wholeFile, recordHistory)); this.decisions = next; return next;
  }
  private async changeDecision(id: string, decision: Decision, wholeFile: boolean, recordHistory: boolean) {
    if (this.queueActive || !this.task || !this.review) throw new Error('Wait for the queue to finish or pause it before reviewing.');
    const edits = wholeFile ? this.review.files.find(f => f.file === id)?.edits || [] : this.review.files.flatMap(f => f.edits).filter(e => e.id === id);
    if (!edits.length) throw new Error('Select a PDF change to review.');
    const dirty = vscode.workspace.textDocuments.find(doc => doc.isDirty && doc.uri.scheme === 'file' && edits.some(edit => path.join(this.root, edit.file) === doc.uri.fsPath));
    if (dirty) throw new Error(`Save the current edits in ${path.basename(dirty.fileName)} before refreshing the review.`);
    const textChanges = edits.some(e => (e.decision === 'rejected') !== (decision === 'rejected'));
    for (const edit of edits) await decide(this.task, this.review, edit.id, decision);
    await this.publishReviewDecisions(edits.map(edit => edit.file));
    if (decision === 'accepted' && recordHistory) await this.recordAcceptance(edits.map(edit => edit.id), `Accepted Change · ${edits[0].file}`);
    if (textChanges) { this.after?.rescan(); try { await this.rebuild(this.task?.mode === 'workspace' ? 'before' : 'after', false); } catch (e) { this.log(String(e)); } await this.paintMarkers(); }
  }
  private async publishReviewDecisions(files: string[]) {
    if (!this.task || !this.review) return;
    const edits = this.review.files.flatMap(file => file.edits), visible = new Set(edits.filter(edit => edit.decision !== 'accepted').map(edit => edit.id));
    this.selectedEdits = new Set([...this.selectedEdits].filter(id => visible.has(id)));
    this.conversation.value.selectedEdits = [...this.selectedEdits]; await this.conversation.save();
    for (const file of this.review.files.filter(file => files.includes(file.file))) if (!file.binary) this.ui.reviewBase.set(this.task.id, file.file, materialize(file, edit => edit.decision === 'accepted')?.toString('utf8') || '', this.root);
    if (this.selectedEdit && !visible.has(this.selectedEdit)) { this.selectedEdit = undefined; this.both({ type: 'selectedEdit', id: null }); }
    const resolved = resolvedNoteIds(this.review), linked = new Set(edits.flatMap(edit => edit.noteIds || []));
    const accepted = new Set(edits.filter(edit => edit.decision === 'accepted').flatMap(edit => edit.noteIds || []));
    let updated = false;
    for (const note of this.notes) if (linked.has(note.id)) {
      const status = resolved.has(note.id) ? 'resolved' : accepted.has(note.id) || note.status === 'reviewing' || note.status === 'resolved' ? 'reviewing' : 'open';
      if (note.status !== status) { note.status = status; updated = true; if (status !== 'open') this.selectedNotes.delete(note.id); }
    }
    if (updated) { this.threads.forEach(thread => thread.dispose()); this.threads = []; await this.saveNotes(); this.conversation.value.selectedNotes = [...this.selectedNotes]; await this.saveConversation(); }
    const decisions = new Map(edits.map(edit => [edit.id, edit.decision]));
    for (const side of ['before', 'after'] as const) this.markers[side] = this.markers[side].filter(marker => decisions.has(marker.id)).map(marker => ({ ...marker, decision: decisions.get(marker.id)! }));
    this.ui.refresh(); this.both({ type: 'decisions', edits: edits.map(edit => ({ id: edit.id, decision: edit.decision })) }); this.both({ type: 'markers', markers: this.markers });
  }
  async showEdit(id: string) {
    const file = this.review?.files.find(f => f.edits.some(e => e.id === id)), edit = file?.edits.find(e => e.id === id);
    if (!file || !edit || !this.task) return;
    if (!file.file.toLowerCase().endsWith('.tex')) { await this.diff(file.file, id); return; }
    await this.diff(file.file, id);
    if (this.selectedEdit !== id) return;
    if (!this.proposalPanel) this.showProposal(true);
    let a = this.markers.before.find(m => m.id === id), b = this.markers.after.find(m => m.id === id);
    if (!a || a.unresolved || this.task.mode !== 'workspace' && (!b || b.unresolved)) { await this.paintMarkers(); a = this.markers.before.find(m => m.id === id); b = this.markers.after.find(m => m.id === id); }
    if (this.selectedEdit !== id) return;
    if (a) { this.before?.showPage(a.page); this.post(this.panelFor('before'), { type: 'reveal', page: a.page, rect: a.rects[0], id }); }
    if (b) { this.after?.showPage(b.page); this.post(this.panelFor('after'), { type: 'reveal', page: b.page, rect: b.rects[0], id }); }
    this.page = (this.mainViewSide === 'after' ? b?.page : a?.page) || 0; this.alignedPage = this.mainViewSide === 'after' ? a?.page : b?.page;
    if (a?.bounds && b?.bounds) this.both({ type: 'alignment', sourceSide: 'before', source: { page: a.page, x: a.rects[0][0], y: a.rects[0][1], bounds: a.bounds }, target: { page: b.page, x: b.rects[0][0], y: b.rects[0][1], bounds: b.bounds } });
    this.both({ type: 'selectedEdit', id }); this.ui.refresh();
  }
  private showReviewCard(id: string, panel: vscode.WebviewPanel) {
    const file = this.review?.files.find(file => file.edits.some(edit => edit.id === id)), edit = file?.edits.find(edit => edit.id === id);
    if (!file || !edit) throw new Error('This change is no longer available. Refresh Current Changes and select it again.');
    const request = this.review?.requests?.find(request => request.id === edit.requestId);
    const notes = request?.notes.filter(note => edit.noteIds?.includes(note.id)) || [];
    this.selectedEdit = id; this.both({ type: 'selectedEdit', id });
    this.post(panel, { type: 'reviewDetails', id, origin: edit.origin || 'editor', notes: notes.length ? notes : edit.origin === 'annotation' ? request?.notes || [] : [], instruction: request?.instruction || '', removed: edit.removed, inserted: edit.inserted, file: file.file, line: edit.beforeLine, decision: edit.decision });
  }
  private async followupReview(id: string) {
    const file = this.review?.files.find(file => file.edits.some(edit => edit.id === id)), edit = file?.edits.find(edit => edit.id === id);
    if (!file || !edit) throw new Error('This change is no longer available. Refresh Current Changes and select it again.');
    const request = this.review?.requests?.find(request => request.id === edit.requestId);
    const related = request?.notes.filter(note => edit.noteIds?.includes(note.id)) || [];
    for (const note of related) if (!this.notes.some(item => item.id === note.id)) this.notes.push({ ...structuredClone(note), status: 'resolved' });
    if (related.length) await this.saveNotes();
    const context = related.length ? related.map(note => `Annotation ${note.number || ''}: ${note.comment}`).join('\n') : request?.instruction || `${file.file}:${edit.beforeLine} changes`;
    await this.revise(related, `Regarding ${context}\n\nFollow Up: `);
  }
  async nextEdit(direction: number) {
    const edits = this.review?.files.flatMap(f => f.edits).filter(edit => edit.decision !== 'accepted') || []; if (!edits.length) return;
    const current = edits.findIndex(e => e.id === this.selectedEdit), index = (current + direction + edits.length) % edits.length;
    await this.showEdit(edits[index].id); await this.reviewPopup(edits[index].id);
  }
  async reviewPopup(id?: string) {
    const file = this.review?.files.find(f => f.edits.some(e => e.id === id)), edit = file?.edits.find(e => e.id === id);
    if (!file || !edit) return; this.selectedEdit = edit.id;
    const action = await vscode.window.showQuickPick([
      { label: '$(check) Accept Change', value: 'accepted' }, { label: '$(discard) Reject Change', value: 'rejected' },
      { label: '$(comment) Follow Up', value: 'comment' }, { label: '$(circle-outline) Mark Pending', value: 'pending' },
      { label: '$(diff) View Source Diff', value: 'diff' }, { label: '$(check-all) Finish Review', value: 'apply' }
    ], { title: `PDF Change · ${file.file}:${edit.beforeLine}`, placeHolder: `${edit.removed.slice(0, 100)} → ${edit.inserted.slice(0, 100)}`, ignoreFocusOut: false });
    if (!action) return;
    if (['accepted', 'rejected', 'pending'].includes(action.value)) await this.setDecision(edit.id, action.value as Decision);
    else if (action.value === 'diff') await this.diff(file.file, edit.id);
    else if (action.value === 'apply') await this.apply();
    else await this.followupReview(edit.id);
  }
  async showPage(page: number) {
    this.page = Math.max(0, Math.min(10000, Math.floor(page))); const generation = ++this.alignmentGeneration;
    if (!this.task || !this.before || !this.after) { this.before?.showPage(this.page); this.post(this.panel, { type: 'navigate', page: this.page }); this.ui.refresh(); return; }
    const sourceSide = this.currentSide, source = sourceSide === 'before' ? this.before : this.after, target = sourceSide === 'before' ? this.after : this.before;
    source.showPage(this.page); this.post(this.panelFor(sourceSide), { type: 'navigate', page: this.page }); this.ui.refresh();
    try {
      const frame = await source.readPage(this.page), chars = frame.header.characters?.filter(c => c[0] > 32) || [];
      const middle = chars[Math.floor(chars.length / 2)]; if (!middle) throw new Error('This page has no locatable text.');
      const location = await source.source(frame.header, [middle.slice(1)], String.fromCodePoint(middle[0]));
      const fromRoot = sourceSide === 'before' ? this.task.baseline : this.task.proposal, toRoot = sourceSide === 'before' ? this.task.proposal : this.task.baseline;
      const [from, to] = await Promise.all([fs.readFile(path.join(fromRoot, location.file), 'utf8'), fs.readFile(path.join(toRoot, location.file), 'utf8')]);
      const mapped = mapLine(from, to, location.line), point = await target.position(path.join(toRoot, location.file), mapped.line);
      if (generation !== this.alignmentGeneration) return;
      this.alignedPage = point.page; target.showPage(point.page);
      this.post(this.panelFor(sourceSide === 'before' ? 'after' : 'before'), { type: 'navigate', page: point.page });
      const targetFrame = await target.readPage(point.page);
      this.both({ type: 'alignment', sourceSide, source: { page: frame.header.page, x: middle[1], y: middle[2], bounds: frame.header.bounds }, target: { ...point, bounds: targetFrame.header.bounds } });
    } catch (e) { this.log(`Cross-page alignment is temporarily unavailable: ${String(e)}\n`); if (generation === this.alignmentGeneration) { this.alignedPage = undefined; target.showPage(this.page); this.both({ type: 'alignmentUnavailable' }); } }
    this.ui.refresh();
  }
  toggleRegion() { this.tool = this.tool === 'text' ? 'region' : 'text'; this.both({ type: 'tool', tool: this.tool }); void vscode.window.setStatusBarMessage(this.tool === 'region' ? 'PDF: drag a region around an equation or figure to annotate it' : 'PDF: select text to add an annotation', 4000); }
  zoom(delta: number, fit = false) { this.zoomLevel = fit ? 1 : Math.min(3, Math.max(.5, this.zoomLevel + delta)); this.both({ type: 'zoom', zoom: this.zoomLevel }); }
  toggleDifference() { if (this.task?.mode === 'workspace') return this.compare(); this.difference = !this.difference; this.both({ type: 'difference', enabled: this.difference }); }
  async diff(file: string, id?: string) {
    const data = this.review?.files.find(f => f.file === file); if (!this.task || !data) return;
    const right = vscode.Uri.file(path.join(this.task.proposal, file)), empty = vscode.Uri.from({ scheme: 'untitled', path: `/empty-${randomUUID()}` });
    const left = data.binary ? data.before === undefined ? empty : vscode.Uri.file(path.join(this.task.baseline, file)) : this.ui.reviewBase.set(this.task.id, file, materialize(data, edit => edit.decision === 'accepted')?.toString('utf8') || '', this.root);
    const edit = data.edits.find(e => e.id === id); let selection: vscode.Range | undefined;
    if (edit && !data.binary) {
      this.selectedEdit = edit.id;
      const document = await vscode.workspace.openTextDocument(data.proposed === undefined ? left : right), position = editPosition(data, edit);
      const start = document.positionAt(position.offset), end = document.positionAt(position.offset + (edit.decision === 'rejected' ? edit.removed.length : edit.inserted.length));
      selection = new vscode.Range(start, end);
    }
    await vscode.commands.executeCommand('vscode.diff', left, data.proposed === undefined ? empty : right, `Task changes · ${file}`, { viewColumn: this.sourceColumn(this.main), preview: false, selection });
    this.ui.refresh();
  }
  async apply() {
    await this.decisions;
    if (this.queueActive || !this.task || !this.review) return;
    if (this.task.mode === 'workspace') {
      if (this.dirtyProjectDocument()) throw new Error('Save your current edits before finishing the review.');
      if (this.review.files.some(file => file.edits.some(edit => edit.decision === 'pending'))) throw new Error('There are changes pending review. Accept or reject them before finishing the review.');
      await this.finishTask(); return;
    }
    const plan = reviewPlan(this.review, true); if (!plan.length) throw new Error('Accept at least one PDF change first.');
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty && doc.uri.scheme === 'file' && plan.some(c => path.resolve(this.root, c.file) === doc.uri.fsPath)) throw new Error(`Save the current edits in ${doc.fileName} before applying changes and checking conflicts.`);
    this.busy = true; this.proposalWatcher?.dispose(); clearTimeout(this.buildTimers.get('after')); this.ui.refresh();
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Validating and applying accepted PDF changes' }, async () => {
      // Compile exactly the accepted combination before changing the manuscript.
      const restore = new Map<string, Buffer | undefined>();
      try {
        for (const file of this.review!.files) {
          const target = path.join(this.task!.proposal, file.file); restore.set(target, materialize(file, e => e.decision !== 'rejected'));
          const accepted = materialize(file, e => e.decision === 'accepted');
          if (accepted) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, accepted); } else await fs.unlink(target).catch(() => {});
        }
        if (this.afterBuild) await this.buildNow(this.afterBuild);
      } finally {
        for (const [target, bytes] of restore) if (bytes) await fs.writeFile(target, bytes); else await fs.unlink(target).catch(() => {});
      }
      this.lastApplication = await applyWithUndo(this.root, plan, this.context.globalStorageUri.fsPath);
      this.conversation.value.contextUpdates.push(`Accepted changes in ${plan.length} files have been applied to the manuscript.`);
      this.conversation.value.messages.push({ id: randomUUID(), role: 'system', text: `Changes to ${plan.length} files have been applied. Subsequent tasks continue in this session.` }); await this.saveConversation();
      await this.context.workspaceState.update(`undo:${this.root}`, this.lastApplication); await this.finishTask(true);
    }); } finally { this.busy = false; if (this.task) this.watchProposal(); else this.scheduleAnchors(); this.ui.refresh(); }
    vscode.window.setStatusBarMessage(`Applied accepted changes in ${plan.length} files. Use Undo Round to restore them.`, 5000);
  }
  async undo() {
    if (this.queueActive) throw new Error('Stop the current task before undoing this round.');
    if (this.dirtyProjectDocument()) throw new Error('Save your current edits before undoing this round.');
    if (this.task?.mode === 'workspace') { await this.workingTree?.capture(); if (!(await changes(this.task)).length) throw new Error('This round has no changes to undo.'); await this.finishTask(); }
    if (this.task) throw new Error('End the current task before undoing the last operation.');
    if (!this.lastApplication) return; await undoApplication(this.lastApplication, this.root);
    this.lastApplication = undefined; await this.context.workspaceState.update(`undo:${this.root}`, undefined);
    this.conversation.value.contextUpdates.push('The author undid the last operation. The manuscript has been restored; use the current files.'); this.conversation.value.messages.push({ id: randomUUID(), role: 'system', text: 'The last operation was undone. The current conversation and context are retained.' }); await this.saveConversation();
    await this.reconcileOriginalNotes(); await this.rebuild('before', false); this.before?.rescan(); await this.refreshAnchors(); this.ui.refresh();
    vscode.window.setStatusBarMessage('This round has been undone and the paper restored.', 5000);
  }
  private async reconcileOriginalNotes() {
    const files = new Set(this.notes.flatMap(n => n.source ? [n.source.file] : []));
    for (const file of files) try { const current = await fs.readFile(path.join(this.root, file), 'utf8'); const old = this.versions.get(file); if (old !== undefined) trackNotes(this.notes.filter(n => !n.proposalTask), file, old, current); this.versions.set(file, current); } catch { for (const n of this.notes) if (n.source?.file === file) n.anchorStatus = 'orphaned'; }
    if (this.notes.length) await this.saveNotes();
  }
  async finishTask(internal = false) {
    await this.decisions;
    if (this.queueActive && !internal) throw new Error('Pause the current queue before ending the review.');
    if (this.task?.mode === 'workspace') {
      if (this.dirtyProjectDocument()) throw new Error('Save your current edits before ending this review round.');
      await this.workingTree?.capture();
      const plan = await changes(this.task);
      if (plan.length) {
        this.lastApplication = await recordWorkspace(this.task, plan);
        await this.context.workspaceState.update(`undo:${this.root}`, this.lastApplication);
      }
      this.conversation.value.contextUpdates.push('This review round has ended. All retained changes are in the live project files. Continue reading the current files.');
      this.conversation.value.messages.push({ id: randomUUID(), role: 'system', text: `Review complete; changes in ${plan.length} files remain in the project and can be undone as a round.` });
      for (const group of vscode.window.tabGroups.all) {
        const tabs = group.tabs.filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === 'pdfLocal.reviewBase' && tab.input.original.path.startsWith(`/${this.task!.id}/`));
        if (!tabs.length) continue;
        await vscode.window.showTextDocument(vscode.Uri.file(this.main), { viewColumn: group.viewColumn, preview: false, preserveFocus: true });
        await vscode.window.tabGroups.close(tabs, true);
      }
      this.task.ended = true; await fs.writeFile(path.join(this.task.dir, 'task.json'), JSON.stringify(this.task, null, 2));
      this.task = undefined; this.workingTree = undefined; this.review = undefined; this.selectedEdit = undefined; this.alignedPage = undefined;
      this.selectedEdits.clear(); this.conversation.value.selectedEdits = [];
      await this.context.workspaceState.update(this.key, undefined);
      this.markers = { before: [], after: [] }; this.both({ type: 'markers', markers: this.markers });
      await this.saveConversation(); await this.refreshAnchors(); this.ui.refresh(); return;
    }
    this.proposalWatcher?.dispose(); this.proposalWatcher = undefined; clearTimeout(this.buildTimers.get('after'));
    if (this.task) for (const note of this.notes) if (note.proposalTask === this.task.id && note.source) {
      try { const [from, to] = await Promise.all([fs.readFile(path.join(this.task.proposal, note.source.file), 'utf8'), fs.readFile(path.join(this.root, note.source.file), 'utf8')]); trackNotes([note], note.source.file, from, to); } catch { note.anchorStatus = 'orphaned'; }
    }
    await this.after?.stop(); await this.afterBuild?.stop(); this.after = undefined; this.afterBuild = undefined; this.proposalPanel?.dispose(); this.proposalPanel = undefined;
    this.task = undefined; this.review = undefined; this.selectedEdit = undefined; this.alignedPage = undefined; await this.context.workspaceState.update(this.key, undefined);
    this.mainViewSide = 'before'; this.currentSide = 'before'; this.syncPanel(this.panel, 'before');
    this.panel.title = `Paper · ${path.basename(this.main)}`; this.difference = false; this.both({ type: 'hasTask', value: false }); this.both({ type: 'difference', enabled: false }); this.markers = { before: [], after: [] }; this.both({ type: 'markers', markers: this.markers });
    await this.reconcileOriginalNotes(); for (const note of this.notes) delete note.proposalTask; this.proposalVersions.clear(); if (this.notes.length) await this.saveNotes(); await this.startSide('before', this.root, path.relative(this.root, this.main)); await this.refreshAnchors(); this.ui.refresh();
  }
  async dispose(closePanels = true) {
    if (this.disposed) return; this.disposed = true; clearTimeout(this.anchorTimer); clearTimeout(this.markerTimer); this.buildTimers.forEach(clearTimeout); this.proposalWatcher?.dispose();
    if (closePanels) { this.proposalPanel?.dispose(); this.chatPanel?.dispose(); }
    this.threads.forEach(t => t.dispose()); this.resources.forEach(r => r.dispose());
    if (this.queueActive || this.conversation.value.queue.length) this.conversation.value.paused = true;
    await this.run?.stop(); await this.workingTree?.capture(); await Promise.all([this.before?.stop(), this.after?.stop(), this.beforeBuild?.stop(), this.afterBuild?.stop()]); await this.draining; await this.conversation.save(); this.ui.closed(this);
  }
}
