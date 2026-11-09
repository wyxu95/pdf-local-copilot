/* PDF pages, margin annotations, and hit testing. Workspace actions stay in VS Code. */
import { horizontalCrop, inkBounds, surfaceTransform, sourcePoint, textLines, lineCaret, textCaret, quoteGeometry, placeOverlayLabels } from '../src/view-geometry';
import { referenceKind, referenceLinkAt, referenceLabel, referencePreviewBounds } from '../src/reference-preview';
(() => {
  const vscode = acquireVsCodeApi(), viewport = document.querySelector('#viewport'), pages = document.querySelector('#pages');
  const state = {
    side: 'before', meta: { before: null, after: null }, frames: { before: new Map(), after: new Map() },
    rows: new Map(), notes: [], markers: { before: [], after: [] }, draft: null, edits: new Map(),
    tool: 'text', zoom: 1, difference: false, alignment: null, currentPage: 0, pendingReveal: null, sourceLocation: null,
    queue: [], queued: new Set(), failed: new Set(), pending: null, selectedEdit: null, focusedNote: null, openNote: null, openReview: null, chat: null
  };
  const send = value => vscode.postMessage(value);
  let documentState = vscode.getState() || {};
  const make = (tag, className, text) => { const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const key = (side, page, session) => `${side}:${page}:${session}`;
  const version = frame => `${frame.side}:${frame.session}:${frame.header.sequence}:${frame.header.revision}`;
  const fresh = (side, frame) => {
    const meta = state.meta[side];
    return !!frame && !!meta && !meta.pending && frame.session === meta.session && frame.header.sequence === meta.sequence && frame.header.revision === meta.revision;
  };
  function rectStyle(element, rect, bounds) {
    Object.assign(element.style, {
      left: `${(rect[0] - bounds[0]) / (bounds[2] - bounds[0]) * 100}%`, top: `${(rect[1] - bounds[1]) / (bounds[3] - bounds[1]) * 100}%`,
      width: `${(rect[2] - rect[0]) / (bounds[2] - bounds[0]) * 100}%`, height: `${(rect[3] - rect[1]) / (bounds[3] - bounds[1]) * 100}%`
    });
  }
  function notesFor(page) { return state.notes.filter(note => (!note.status || note.status === 'open') && note.page === page && (note.proposalTask ? state.side === 'after' : state.side === 'before')); }
  function noteRects(note) {
    const frame = state.rows.get(note.page)?.frame;
    return frame && !note.region ? quoteGeometry(frame.header, note.quote, note.rects[0]) || [] : note.rects;
  }
  function createRow(page) {
    const row = make('section', 'page-row'); row.dataset.page = page;
    const paper = make('div', 'paper'); paper.id = page === 0 ? 'paper' : `paper-${page + 1}`; paper.dataset.page = page; paper.dataset.side = state.side;
    const placeholder = make('p', 'page-loading', `Loading page ${page + 1}…`); paper.append(placeholder);
    row.append(paper); pages.append(row);
    const record = { page, row, paper, frame: null, surface: null, renderKey: '', bounds: [0, 0, 612, 792], crop: [0, 0, 612, 792], diffToken: 0 };
    state.rows.set(page, record); observer.observe(row);
    paper.addEventListener('pointerdown', e => pointerDown(e, record));
    paper.addEventListener('pointermove', e => pointerMove(e, record));
    paper.addEventListener('pointerup', e => pointerUp(e, record));
    paper.addEventListener('pointercancel', () => { textDrag = null; drag = null; });
    paper.addEventListener('mouseup', e => selectText(e, record));
    paper.addEventListener('pointerleave', hideReferenceAfterLeave);
    resize.observe(paper); return record;
  }
  function ensureRows(required = 0) {
    const meta = state.meta[state.side];
    const count = Math.max(1, meta?.complete ? meta.pages : Math.max((meta?.pages || 0) + 1, required, state.rows.size));
    for (let page = 0; page < count; page++) if (!state.rows.has(page)) createRow(page);
    for (const [page, record] of state.rows) if (page >= count) { observer.unobserve(record.row); resize.unobserve(record.paper); record.row.remove(); state.rows.delete(page); }
    updateRailVisibility();
  }
  const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) enqueue(state.side, Number(entry.target.dataset.page)); }, { root: viewport, rootMargin: '900px 0px' });
  const resize = new ResizeObserver(entries => {
    dismissReference();
    for (const entry of entries) {
      if (entry.target === viewport) { document.body.style.setProperty('--view-width', `${viewport.clientWidth}px`); continue; }
      const record = state.rows.get(Number(entry.target.dataset.page)); if (record) layoutCards(record);
    }
  });
  resize.observe(viewport);
  function enqueue(side, page, force = false) {
    const meta = state.meta[side]; if (!meta || page < 0 || page > 10000 || meta.complete && page >= meta.pages) return;
    if (!force && fresh(side, state.frames[side].get(page))) {
      const record = side === state.side ? state.rows.get(page) : null;
      if (record && !record.frame) drawPage(record, state.frames[side].get(page));
      return;
    }
    const id = key(side, page, meta.session); if (state.queued.has(id) || state.pending?.key === id) return;
    if (state.failed.has(id) && !force) return; if (force) state.failed.delete(id);
    state.queue.push({ side, page, session: meta.session, key: id }); state.queued.add(id); pump();
  }
  function pump() {
    if (state.pending || !state.queue.length) return;
    state.queue.sort((a, b) => Math.abs(a.page - state.currentPage) - Math.abs(b.page - state.currentPage));
    while (state.queue.length) {
      const request = state.queue.shift(); state.queued.delete(request.key);
      const meta = state.meta[request.side];
      if (!meta || request.session !== meta.session || meta.complete && request.page >= meta.pages || fresh(request.side, state.frames[request.side].get(request.page))) continue;
      state.pending = request; send({ type: 'requestPage', side: request.side, page: request.page, session: request.session }); break;
    }
  }
  function requestVisible() {
    const box = viewport.getBoundingClientRect();
    for (const record of state.rows.values()) {
      const rect = record.row.getBoundingClientRect();
      if (rect.bottom > box.top - box.height && rect.top < box.bottom + box.height) enqueue(state.side, record.page);
    }
  }
  let scrollFrame = 0, visibleTimer;
  function onScroll() {
    dismissReference();
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const box = viewport.getBoundingClientRect(), focus = box.top + box.height * .38;
      let page = state.currentPage, distance = Infinity;
      for (const record of state.rows.values()) {
        const rect = record.paper.getBoundingClientRect(), d = focus < rect.top ? rect.top - focus : focus > rect.bottom ? focus - rect.bottom : 0;
        if (d < distance) { distance = d; page = record.page; }
      }
      if (page !== state.currentPage) { state.currentPage = page; documentState.page = page; vscode.setState(documentState); clearTimeout(visibleTimer); visibleTimer = setTimeout(() => send({ type: 'visiblePage', page }), 100); }
      requestVisible(); positionAnnotation();
      for (const record of state.rows.values()) if (Math.abs(record.page - page) > 3 && record.frame && state.draft?.page !== record.page && state.notes.find(n => n.id === state.openNote)?.page !== record.page) {
        record.frame = null; record.renderKey = ''; record.paper.replaceChildren(make('p', 'page-loading', `Page ${record.page + 1}`));
      }
      for (const side of ['before', 'after']) while (state.frames[side].size > 10) {
        const farthest = [...state.frames[side].keys()].sort((a, b) => Math.abs(b - page) - Math.abs(a - page))[0];
        state.frames[side].delete(farthest);
      }
    });
  }
  viewport.addEventListener('scroll', onScroll, { passive: true });
  function putFrame(message) {
    const meta = state.meta[message.side]; if (!meta || message.session !== meta.session) return;
    const previous = state.frames[message.side].get(message.header.page);
    if (previous && (previous.header.sequence > message.header.sequence || previous.header.sequence === message.header.sequence && previous.header.revision > message.header.revision)) return;
    state.frames[message.side].set(message.header.page, message);
    if (message.side === state.side) {
      ensureRows(message.header.page + 1);
      const record = state.rows.get(message.header.page); if (record && (Math.abs(record.page - state.currentPage) <= 3 || state.pendingReveal?.page === record.page)) drawPage(record, message);
    } else for (const record of state.rows.values()) if (record.frame) difference(record);
    reveal();
  }
  function drawPage(record, frame) {
    const nextKey = version(frame), b = frame.header.bounds;
    record.paper.classList.toggle('region-mode', state.tool === 'region');
    if (record.renderKey !== nextKey && record.pendingKey !== nextKey) {
      record.pendingKey = nextKey;
      const clip = make('div', 'page-clip'), surface = make('div', 'page-surface');
      const image = new Image(); image.className = 'page-image'; image.alt = `Paper page ${record.page + 1}`; image.draggable = false;
      image.src = `data:${frame.header.mime};base64,${frame.data}`;
      const layer = make('div', 'text-layer');
      const lines = textLines(frame.header.characters || []), charNodes = new Map();
      for (const [index, c] of (frame.header.characters || []).entries()) {
        if (c[0] === 10) { layer.append(document.createTextNode('\n')); continue; }
        const span = make('span', '', c[0] ? String.fromCodePoint(c[0]) : '�'); span.dataset.rect = JSON.stringify(c.slice(1)); span.dataset.charIndex = index; charNodes.set(index, span); rectStyle(span, c.slice(1), b);
        span.style.fontSize = `${(c[4] - c[2]) / (b[3] - b[1]) * 86}cqh`; layer.append(span);
      }
      surface.append(image, layer); clip.append(surface);
      void image.decode().then(() => {
        if (record.pendingKey !== nextKey || !record.row.isConnected || state.side !== frame.side) return;
        const canvas = document.createElement('canvas'); canvas.width = Math.min(600, image.naturalWidth); canvas.height = Math.max(1, Math.round(canvas.width * image.naturalHeight / image.naturalWidth));
        const context = canvas.getContext('2d', { willReadFrequently: true }); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const crop = horizontalCrop(b, inkBounds(b, canvas.width, canvas.height, context.getImageData(0, 0, canvas.width, canvas.height).data));
        if (record.frame && b.every((v, i) => v === record.bounds[i])) { crop[0] = Math.min(crop[0], record.crop[0]); crop[2] = Math.max(crop[2], record.crop[2]); }
        record.frame = frame; record.bounds = b; record.surface = surface; record.lines = lines; record.charNodes = charNodes;
        record.renderKey = nextKey; record.pendingKey = null;
        record.paper.replaceChildren(clip); applyCrop(record, crop);
        record.paper.classList.toggle('stale', !fresh(state.side, frame));
        record.imageReady = true; record.paper.dataset.cropReady = 'true';
        record.paper.dataset.renderVersion = nextKey;
        if (state.draft?.page === record.page && state.draft.kind === 'text' && !state.draft.pending) {
          const rects = quoteGeometry(frame.header, state.draft.quote, state.draft.rects[0]);
          if (rects) { state.draft.rects = rects; state.draft.header = frame.header; state.draft.session = frame.session; }
        }
        drawMarks(record); renderAnnotation(); layoutCards(record); difference(record); reveal();
      }).catch(error => { if (record.pendingKey === nextKey) { record.pendingKey = null; console.error('PDF page decode failed', error); } });
    }
    drawMarks(record); renderCards(record); difference(record);
  }
  function applyCrop(record, crop) {
    record.crop = crop; const transform = surfaceTransform(record.bounds, crop);
    record.paper.style.aspectRatio = String(transform.aspectRatio); record.paper.dataset.cropLeft = crop[0]; record.paper.dataset.cropRight = crop[2];
    record.surface.style.left = `${transform.left}%`; record.surface.style.width = `${transform.width}%`;
  }
  const referenceCard = make('section', 'reference-preview'); referenceCard.id = 'reference-preview'; referenceCard.hidden = true; referenceCard.setAttribute('role', 'tooltip');
  const referenceHeading = make('strong', '', 'Reference Preview'), referenceContent = make('div', 'reference-content');
  const referenceJump = action('Go to Target', () => { const current = hoveredReference; dismissReference(); if (current) send({ ...current.payload, type: 'referenceJump' }); });
  const referenceClose = action('×', dismissReference); referenceClose.setAttribute('aria-label', 'Close reference preview');
  const referenceHeader = make('header', 'reference-header'); referenceHeader.append(referenceHeading, referenceJump, referenceClose); referenceCard.append(referenceHeader, referenceContent); viewport.append(referenceCard);
  let hoveredReference = null, referenceTimer, referenceHideTimer, referenceRequest = 0;
  const referenceCache = new Map();
  referenceCard.addEventListener('pointerenter', () => clearTimeout(referenceHideTimer));
  referenceCard.addEventListener('pointerleave', hideReferenceAfterLeave);
  function hideReferenceAfterLeave() {
    clearTimeout(referenceHideTimer); referenceHideTimer = setTimeout(() => { if (!referenceCard.matches(':hover')) dismissReference(); }, 140);
  }
  function dismissReference() {
    clearTimeout(referenceTimer); clearTimeout(referenceHideTimer); hoveredReference = null; referenceRequest++; referenceCard.hidden = true;
    for (const record of state.rows.values()) record.paper.classList.remove('reference-link-hover');
  }
  function referencePayload(record, hit) { return { requestId: ++referenceRequest, session: record.frame.session, sequence: record.frame.header.sequence, revision: record.frame.header.revision, page: record.page, linkIndex: hit.index }; }
  function referenceScale(record) { return record.surface.getBoundingClientRect().width / (record.bounds[2] - record.bounds[0]); }
  function positionReference() {
    if (!hoveredReference || referenceCard.hidden) return;
    const record = hoveredReference.record, b = record.bounds, surface = record.surface.getBoundingClientRect(), outer = viewport.getBoundingClientRect(), rect = hoveredReference.hit.link.bounds;
    const x = surface.left + (rect[0] - b[0]) / (b[2] - b[0]) * surface.width, top = surface.top + (rect[1] - b[1]) / (b[3] - b[1]) * surface.height, bottom = surface.top + (rect[3] - b[1]) / (b[3] - b[1]) * surface.height;
    referenceCard.style.width = `${Math.min(viewport.clientWidth - 16, Math.max(250, (hoveredReference.width || 0) + 18))}px`;
    const left = Math.max(8, Math.min(x - outer.left, viewport.clientWidth - referenceCard.offsetWidth - 8));
    const y = bottom - outer.top + 8 + referenceCard.offsetHeight <= viewport.clientHeight - 8 ? bottom - outer.top + 8 : Math.max(8, top - outer.top - referenceCard.offsetHeight - 8);
    referenceCard.style.left = `${viewport.scrollLeft + left}px`; referenceCard.style.top = `${viewport.scrollTop + y}px`;
  }
  function hoverReference(event, record) {
    if (event.buttons || event.ctrlKey || event.metaKey || event.pointerType === 'touch' || !record.imageReady || !fresh(state.side, record.frame) || state.tool !== 'text' || state.openNote || state.openReview || state.draft?.phase === 'editing' && !state.draft.hidden) { dismissReference(); return; }
    const hit = referenceLinkAt(record.frame.header, ...point(event, record));
    if (!hit) { hideReferenceAfterLeave(); return; }
    clearTimeout(referenceHideTimer); record.paper.classList.add('reference-link-hover');
    const key = `${version(record.frame)}:${record.page}:${hit.index}:${Math.ceil(referenceScale(record) * window.devicePixelRatio * 1000)}`;
    if (hoveredReference?.key === key) return;
    dismissReference();
    hoveredReference = { record, hit, key, payload: referencePayload(record, hit), label: referenceLabel(record.frame.header, hit.link.bounds) };
    record.paper.classList.add('reference-link-hover');
    referenceTimer = setTimeout(() => {
      if (!hoveredReference || hoveredReference.key !== key) return;
      referenceCard.hidden = false; referenceHeading.textContent = 'Reference Preview'; referenceContent.replaceChildren(make('p', '', 'Loading preview…')); positionReference();
      const cached = referenceCache.get(key);
      if (cached) showReference(cached); else send({ ...hoveredReference.payload, type: 'referencePreview' });
    }, 280);
  }
  async function showReference(preview) {
    const current = hoveredReference; if (!current) return;
    const image = new Image(); image.src = preview.image; image.alt = `${preview.kind} preview on page ${preview.target.page + 1}`;
    await image.decode(); if (hoveredReference !== current) return;
    const label = hoveredReference.label.match(/\[[^\]]+\]|\d+[a-z]?(?:[–−-]\d+[a-z]?)?/i)?.[0] || hoveredReference.label.replace(/[,.;:\s]+$/, '');
    referenceHeading.textContent = `${preview.kind}${label ? ' ' + label : ''} · Page ${preview.target.page + 1}`;
    hoveredReference.width = (preview.bounds[2] - preview.bounds[0]) * referenceScale(hoveredReference.record);
    image.style.width = `${hoveredReference.width}px`;
    referenceContent.replaceChildren(image); referenceCard.hidden = false; positionReference();
  }
  async function renderReference(message) {
    const current = hoveredReference; if (!current || current.payload.requestId !== message.requestId) return;
    if (message.error) { referenceContent.replaceChildren(make('p', '', message.error)); positionReference(); return; }
    const image = new Image(); image.src = `data:${message.header.mime};base64,${message.data}`; await image.decode();
    if (hoveredReference !== current) return;
    const canvas = document.createElement('canvas'); canvas.width = Math.min(900, image.naturalWidth); canvas.height = Math.round(canvas.width * image.naturalHeight / image.naturalWidth);
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const kind = referenceKind(message.target.name), bounds = referencePreviewBounds(message.header, message.target, kind, { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data });
    current.kind = kind;
    const width = Math.min(4096, Math.max(128, Math.ceil((bounds[2] - bounds[0]) * referenceScale(current.record) * window.devicePixelRatio)));
    send({ ...current.payload, type: 'referenceImage', bounds, width });
  }
  async function renderReferenceImage(message) {
    const current = hoveredReference; if (!current || current.payload.requestId !== message.requestId) return;
    if (message.error) { referenceContent.replaceChildren(make('p', '', message.error)); positionReference(); return; }
    const preview = { kind: current.kind, target: message.target, bounds: message.header.bounds, image: `data:${message.header.mime};base64,${message.data}` }; referenceCache.set(current.key, preview);
    if (referenceCache.size > 8) referenceCache.delete(referenceCache.keys().next().value); await showReference(preview);
  }
  function drawMarks(record) {
    updateRailVisibility();
    record.paper.querySelectorAll('.review-mark,.review-marker,.note-highlight,.note-marker,.selection-box,.source-location').forEach(e => e.remove());
    if (!record.frame) return;
    if (state.sourceLocation?.side === state.side && state.sourceLocation.page === record.page) for (const rect of state.sourceLocation.rects) {
      const mark = make('div', 'source-location'); rectStyle(mark, rect, record.bounds); record.surface.append(mark);
    }
    notesFor(record.page).forEach((note, index) => {
      const rects = noteRects(note);
      for (const rect of rects) {
        const mark = make('div', `note-highlight${state.focusedNote === note.id ? ' selected' : ''}`); rectStyle(mark, rect, record.bounds); record.surface.append(mark);
      }
      const rect = rects[0]; if (!rect) return;
      const badge = make('button', 'note-marker', `✎${note.number || index + 1}`); badge.title = note.comment; badge.setAttribute('aria-label', `View Annotation ${note.number || index + 1}`);
      const x = Math.max(record.crop[0] + 1, rect[0] - 18); rectStyle(badge, [x, rect[1], x + 16, rect[1] + 14], record.crop);
      badge.dataset.noteId = note.id; badge.onclick = e => { e.stopPropagation(); openNote(note.id); };
      badge.dataset.markerAnchor = JSON.stringify([rect[0], rect[1]]); badge.dataset.markerSide = 'left';
      record.paper.append(badge);
    });
    if (state.draft?.page === record.page) {
      if (state.draft.kind === 'region') for (const rect of state.draft.rects) { const mark = make('div', 'selection-box'); rectStyle(mark, rect, record.bounds); record.surface.append(mark); }
      else drawTextSelection(record, state.draft.rects);
      if (state.draft.phase === 'editing') {
        const rect = state.draft.rects[0], x = Math.max(record.crop[0] + 1, rect[0] - 18);
        const badge = make('button', 'note-marker draft-marker', String(notesFor(record.page).length + 1)); badge.title = 'Continue editing this annotation';
        rectStyle(badge, [x, rect[1], x + 16, rect[1] + 14], record.crop);
        badge.onclick = e => { e.stopPropagation(); state.draft.hidden = false; renderAnnotation(); }; record.paper.append(badge);
        badge.dataset.markerAnchor = JSON.stringify([rect[0], rect[1]]); badge.dataset.markerSide = 'left';
      }
    }
    (state.markers[state.side] || []).filter(m => m.decision !== 'accepted' && m.page === record.page).forEach((marker, index) => {
      if (!marker.unresolved) marker.rects.forEach(rect => { const mark = make('div', `review-mark ${marker.decision}${state.selectedEdit === marker.id ? ' selected' : ''}`); mark.dataset.reviewId = marker.id; rectStyle(mark, rect, record.bounds); record.surface.append(mark); });
      const rect = marker.rects[0]; if (!rect) return;
      const badge = make('button', `review-marker ${marker.decision}`, `${marker.decision === 'accepted' ? '✓' : marker.decision === 'rejected' ? '×' : ''}${index + 1}`);
      badge.dataset.reviewId = marker.id; badge.title = `${marker.label} · ${marker.originLabel || 'Change'} · Click to review this change`; badge.setAttribute('aria-label', `Review Change ${index + 1} · ${marker.originLabel || ''}`);
      badge.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'reviewChange', reviewId: marker.id, preventDefaultContextMenuItems: true }));
      const x = Math.max(record.crop[0] + 1, Math.min(rect[2] + 2, record.crop[2] - 2)); rectStyle(badge, [x, rect[1], x + 21, rect[1] + 16], record.crop);
      badge.onclick = e => { e.stopPropagation(); send({ type: 'reviewChange', id: marker.id }); }; record.paper.append(badge);
      badge.dataset.markerAnchor = JSON.stringify([rect[2], rect[1]]); badge.dataset.markerSide = 'right';
    });
    layoutMarkerBadges(record);
  }
  function layoutMarkerBadges(record) {
    if (!record.frame || !record.surface || !record.lines) return;
    const box = record.paper.getBoundingClientRect(), crop = record.crop, bounds = record.bounds;
    const x = value => (value - crop[0]) / (crop[2] - crop[0]) * box.width, y = value => (value - bounds[1]) / (bounds[3] - bounds[1]) * box.height;
    const badges = [...record.paper.querySelectorAll('[data-marker-anchor]')];
    const labels = badges.map(badge => { const [px, py] = JSON.parse(badge.dataset.markerAnchor), right = badge.dataset.markerSide === 'right'; return { x: x(px) + (right ? 4 : -26), y: y(py) - 22, width: 22, height: 18, fallbackX: right ? box.width + 4 : -26 }; });
    const text = record.lines.map(line => [x(line.bounds[0]), y(line.bounds[1]), x(line.bounds[2]), y(line.bounds[3])]);
    const positions = placeOverlayLabels(labels, text, box.width, box.height);
    badges.forEach((badge, i) => Object.assign(badge.style, { left: `${positions[i].x}px`, top: `${positions[i].y}px`, width: '22px', height: '18px' }));
  }
  function action(label, fn, className = '') { const button = make('button', className, label); button.type = 'button'; button.onclick = fn; return button; }
  const popover = make('section', 'annotation-popover'); popover.id = 'annotation-popover'; popover.hidden = true; popover.setAttribute('aria-label', 'PDF Annotation');
  const addNote = action('✎ Add Annotation', () => { if (state.draft) { window.getSelection()?.removeAllRanges(); state.draft.phase = 'editing'; state.draft.hidden = false; renderAnnotation(); requestAnimationFrame(() => popover.querySelector('textarea')?.focus({ preventScroll: true })); } }, 'selection-action'); addNote.hidden = true;
  viewport.append(popover, addNote); let popupKey = '';
  function activeAnnotation() {
    if (state.openReview) {
      const marker = (state.markers[state.side] || []).find(marker => marker.id === state.openReview.id);
      if (marker) return { page: marker.page, rects: marker.rects, review: { ...state.openReview, decision: marker.decision } };
    }
    if (state.draft && !state.draft.hidden) return { page: state.draft.page, rects: state.draft.rects, draft: state.draft };
    const note = state.notes.find(n => n.id === state.openNote), rects = note && noteRects(note); return rects?.length ? { page: note.page, rects, note } : null;
  }
  function positionAnnotation() {
    const current = activeAnnotation(); if (!current) return;
    const record = state.rows.get(current.page); if (!record?.surface || !current.rects.length) return;
    const surface = record.surface.getBoundingClientRect(), b = record.bounds, outer = viewport.getBoundingClientRect();
    const x = surface.left + (current.rects[0][0] - b[0]) / (b[2] - b[0]) * surface.width;
    const y = surface.top + (Math.max(...current.rects.map(r => r[3])) - b[1]) / (b[3] - b[1]) * surface.height;
    const element = state.draft?.phase === 'selection' && !state.draft.hidden ? addNote : popover;
    element.style.left = `${viewport.scrollLeft + Math.max(8, Math.min(x - outer.left, viewport.clientWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${viewport.scrollTop + y - outer.top + 7}px`;
  }
  function submitAnnotation(queue = false, hide = false) {
    const current = activeAnnotation(); if (!current) return;
    const edit = current.draft || state.edits.get(current.note.id); if (!edit || edit.pending) return;
    const input = popover.querySelector('textarea'); if (input) edit.comment = input.value;
    if (!edit.comment?.trim()) { edit.error = 'Enter an annotation.'; renderAnnotation(); return; }
    edit.pending = true; edit.error = ''; edit.queue = queue; edit.hidden = hide;
    if (current.draft) send({ type: 'annotate', draftId: edit.id, header: edit.header, rects: edit.rects, quote: edit.quote, kind: edit.kind, session: edit.session, comment: edit.comment, runAfterSave: queue });
    else send({ type: 'editNote', id: current.note.id, comment: edit.comment });
    if (hide) state.openNote = null; renderAnnotation(); updateChatControls();
  }
  function closeAnnotation(save = true) {
    state.openReview = null;
    if (state.draft && !state.draft.hidden) {
      const draft = state.draft;
      if (draft.phase === 'selection') { state.draft = null; window.getSelection()?.removeAllRanges(); }
      else if (save && draft.comment?.trim() && !draft.pending) submitAnnotation(false, true);
      else draft.hidden = true;
    } else if (state.openNote) {
      const edit = state.edits.get(state.openNote), note = state.notes.find(n => n.id === state.openNote);
      if (save && edit && note && edit.comment?.trim() && edit.comment !== note.comment && !edit.pending) submitAnnotation(false, true);
      state.openNote = null;
    }
    renderAnnotation(); for (const record of state.rows.values()) if (record.frame) drawMarks(record);
  }
  function openNote(id, editing = false) {
    closeAnnotation(); state.openNote = id; state.focusedNote = id;
    const note = state.notes.find(n => n.id === id); if (!note) return;
    if (editing) state.edits.set(id, { comment: note.comment, pending: false });
    renderAnnotation(); for (const record of state.rows.values()) if (record.frame) drawMarks(record);
    if (editing) requestAnimationFrame(() => popover.querySelector('textarea')?.focus({ preventScroll: true }));
  }
  function renderAnnotation() {
    const current = activeAnnotation();
    if (!current) { popover.hidden = true; addNote.hidden = true; popupKey = ''; return; }
    if (current.review) { renderReviewCard(current.review); positionAnnotation(); return; }
    if (current.draft?.phase === 'selection') {
      popover.hidden = true; addNote.hidden = false; addNote.title = current.draft.quote; popupKey = ''; positionAnnotation(); return;
    }
    addNote.hidden = true; popover.hidden = false;
    const edit = current.draft || state.edits.get(current.note.id), key = current.draft ? `draft:${current.draft.id}` : `note:${current.note.id}:${edit ? 'edit' : 'view'}`;
    if (key !== popupKey) {
      popupKey = key; popover.replaceChildren();
      const body = edit ? make('textarea', 'comment-input') : make('p', 'comment-body', current.note.comment);
      if (edit) {
        body.rows = 3; body.maxLength = 20000; body.value = edit.comment || ''; body.placeholder = 'Describe the revision…'; body.setAttribute('aria-label', 'Annotation text');
        body.oninput = () => { edit.comment = body.value; };
        body.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); submitAnnotation(); } if (e.key === 'Escape') { e.stopPropagation(); closeAnnotation(); } };
      }
      const error = make('p', 'card-error'); error.hidden = true; const footer = make('div', 'card-actions');
      if (edit) footer.append(action('Save', () => submitAnnotation(), 'primary'));
      else footer.append(action('Edit', () => openNote(current.note.id, true)));
      footer.append(action('Delete', () => {
        if (current.draft) { state.draft = null; renderAnnotation(); for (const record of state.rows.values()) if (record.frame) drawMarks(record); }
        else { send({ type: 'deleteNote', id: current.note.id }); state.openNote = null; renderAnnotation(); }
      }));
      const submit = action('Send Task', () => { if (current.draft) submitAnnotation(true); else { if (edit?.comment !== undefined && edit.comment !== current.note.comment) submitAnnotation(); send({ type: 'runNote', id: current.note.id }); } }, 'send-note');
      submit.setAttribute('aria-label', 'Send Task'); footer.append(submit, action('×', () => closeAnnotation(), 'close-annotation'));
      footer.lastChild.title = 'Hide the annotation, keeping its highlight and marker'; popover.append(body, error, footer);
    }
    const textarea = popover.querySelector('textarea'); if (textarea) textarea.disabled = !!edit?.pending;
    popover.querySelectorAll('button').forEach(button => { button.disabled = !!edit?.pending; });
    const submitted = current.note && state.chat?.messages.some(message => ['queued', 'running'].includes(message.status) && message.notes?.some(note => note.id === current.note.id && note.comment === current.note.comment)), submit = popover.querySelector('.send-note');
    if (submit) { submit.textContent = submitted ? 'Task Sent' : 'Send Task'; submit.disabled = !!edit?.pending || !!submitted; }
    if (!edit) popover.querySelector('.comment-body').textContent = current.note.comment;
    const error = popover.querySelector('.card-error'); error.textContent = edit?.error || ''; error.hidden = !edit?.error;
    positionAnnotation();
  }
  function renderReviewCard(review) {
    addNote.hidden = true; popover.hidden = false;
    const key = `review:${review.id}:${review.decision}:${review.pending}:${review.error || ''}`;
    if (popupKey === key) return; popupKey = key; popover.replaceChildren();
    const label = review.origin === 'annotation' ? review.notes.map(note => `Annotation ${note.number || ''}`).join(', ') || 'Annotations' : review.origin === 'session' ? 'From Conversation' : 'From Editor';
    popover.append(make('strong', 'review-origin', label));
    for (const note of review.notes) {
      if (note.quote) popover.append(make('blockquote', 'review-quote', note.quote));
      popover.append(make('p', 'comment-body', note.comment));
    }
    if (review.instruction) popover.append(make('p', 'review-instruction', review.instruction));
    const change = make('details', 'review-text-diff'); change.append(make('summary', '', 'View Text Changes'), make('pre', '', `− ${review.removed}\n+ ${review.inserted}`)); popover.append(change);
    if (review.error) popover.append(make('p', 'card-error', review.error));
    const footer = make('div', 'card-actions');
    const decide = decision => { state.openReview.pending = true; send({ type: 'reviewDecision', id: review.id, decision }); renderAnnotation(); };
    const accept = action(review.decision === 'accepted' ? 'Accepted' : 'Accept Change', () => decide('accepted'), 'primary'); accept.disabled = !!review.pending || review.decision === 'accepted';
    const reject = action(review.decision === 'rejected' ? 'Rejected' : 'Reject Change', () => decide('rejected')); reject.disabled = !!review.pending || review.decision === 'rejected';
    const follow = action('Follow Up', () => { send({ type: 'reviewFollowup', id: review.id }); closeAnnotation(); }); follow.disabled = !!review.pending;
    footer.append(accept, reject, follow, action('Source Diff', () => send({ type: 'reviewDiff', id: review.id })), action('×', () => closeAnnotation())); popover.append(footer);
  }
  function renderCards() { renderAnnotation(); }
  function layoutCards(record) { record.row.style.minHeight = `${record.paper.getBoundingClientRect().height}px`; layoutMarkerBadges(record); positionAnnotation(); }
  function updateRailVisibility() { document.body.classList.toggle('marker-gutters', state.notes.some(note => !note.status || note.status === 'open') || (state.markers[state.side] || []).some(marker => marker.decision !== 'accepted') || state.draft?.phase === 'editing'); }
  function beginDraft(frame, rects, quote, kind = 'text', options = {}) {
    if (state.draft?.pending) return;
    closeAnnotation(); const previous = state.draft;
    state.openNote = null; state.draft = { id: previous?.id || `draft-${Date.now()}`, page: frame.header.page, header: frame.header, session: frame.session, rects, quote, kind, comment: previous?.comment || '', phase: options.editing || kind === 'region' ? 'editing' : 'selection', hidden: false, pending: false };
    ensureRows(frame.header.page + 1); for (const record of state.rows.values()) if (record.frame) drawMarks(record);
    renderAnnotation(); if (state.draft.phase === 'editing') requestAnimationFrame(() => popover.querySelector('textarea')?.focus({ preventScroll: true }));
  }
  function beginEdit(note) { openNote(note.id, true); }
  function annotationError(message) {
    const edit = message.id ? state.edits.get(message.id) : state.draft; if (!edit) return;
    edit.pending = false; edit.hidden = false; edit.error = message.message;
    if (message.id) state.openNote = message.id; renderAnnotation(); updateChatControls();
  }
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.reference-preview')) dismissReference();
    if (event.target.closest('.text-layer,#chat') && !event.target.closest('.annotation-popover,.selection-action,.note-marker,.review-marker')) closeAnnotation();
  }, true);
  function navigate(page, center = false) {
    const meta = state.meta[state.side]; if (meta?.complete) page = Math.min(page, Math.max(0, meta.pages - 1));
    ensureRows(page + 1); state.currentPage = page; const record = state.rows.get(page); if (!record) return;
    enqueue(state.side, page); if (state.frames[state.side].has(page)) drawPage(record, state.frames[state.side].get(page));
    viewport.scrollTop += record.row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (center ? viewport.clientHeight / 3 : 12); onScroll();
  }
  function reveal() {
    const request = state.pendingReveal; if (!request) return;
    const marker = request.id ? (state.markers[state.side] || []).find(m => m.id === request.id) : null, page = marker?.page ?? request.page;
    if (!Number.isInteger(page)) return;
    if (!state.rows.has(page)) ensureRows(page + 1);
    const record = state.rows.get(page), rect = marker?.rects[0] || request.rect;
    if (!record?.frame || !rect) { enqueue(state.side, page); return; }
    const box = record.paper.getBoundingClientRect(), b = record.bounds;
    viewport.scrollTop += box.top + ((rect[1] + rect[3]) / 2 - b[1]) / (b[3] - b[1]) * box.height - viewport.getBoundingClientRect().top - viewport.clientHeight * .4;
    state.pendingReveal = null; onScroll();
  }
  function merge(rects) {
    const result = [];
    for (const rect of rects) {
      const last = result[result.length - 1];
      if (last && Math.abs((last[1] + last[3] - rect[1] - rect[3]) / 2) < 4 && rect[0] <= last[2] + 4) { last[0] = Math.min(last[0], rect[0]); last[1] = Math.min(last[1], rect[1]); last[2] = Math.max(last[2], rect[2]); last[3] = Math.max(last[3], rect[3]); }
      else result.push([...rect]);
    } return result;
  }
  function textSelection(record) {
    const selection = window.getSelection(); if (!selection?.rangeCount || selection.isCollapsed || !record.paper.contains(selection.anchorNode) || !record.paper.contains(selection.focusNode)) return;
    const range = selection.getRangeAt(0), quote = selection.toString().trim().replaceAll('\u0000', '�'); if (!quote) return;
    const rects = [...record.paper.querySelectorAll('.text-layer span')].filter(span => range.intersectsNode(span) && !(span.firstChild === range.endContainer && range.endOffset === 0) && !(span.firstChild === range.startContainer && range.startOffset === span.textContent.length)).map(span => JSON.parse(span.dataset.rect)).filter(rect => rect[2] > rect[0] && rect[3] > rect[1]);
    if (rects.length) return { rects: merge(rects).slice(0, 500), quote };
  }
  function drawTextSelection(record, rects) {
    record.surface.querySelector('.text-selection')?.remove();
    if (!rects.length) return;
    const bounds = [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))];
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('class', 'selection-box text-selection'); svg.setAttribute('viewBox', `${bounds[0]} ${bounds[1]} ${bounds[2] - bounds[0]} ${bounds[3] - bounds[1]}`); svg.setAttribute('preserveAspectRatio', 'none');
    path.setAttribute('d', rects.map(r => `M${r[0]} ${r[1]}H${r[2]}V${r[3]}H${r[0]}Z`).join(' ')); svg.append(path); rectStyle(svg, bounds, record.bounds); record.surface.append(svg);
  }
  function selectText(event, record) {
    if (event.ctrlKey || event.metaKey || sourcePointer || skipSelection || !record.imageReady || state.tool !== 'text' || !fresh(state.side, record.frame)) return;
    const selected = textSelection(record); if (selected) beginDraft(record.frame, selected.rects, selected.quote);
  }
  document.addEventListener('selectionchange', () => {
    for (const record of state.rows.values()) if (record.surface) {
      const selected = textSelection(record);
      if (selected) drawTextSelection(record, selected.rects);
      else if (state.draft?.page !== record.page || state.draft.kind !== 'text') record.surface.querySelector('.text-selection')?.remove();
    }
  });
  document.addEventListener('copy', event => {
    const selection = window.getSelection(), layer = selection?.anchorNode?.parentElement?.closest('.text-layer');
    if (!event.clipboardData || !layer || !layer.contains(selection.focusNode) || selection.isCollapsed) return;
    event.clipboardData.setData('text/plain', selection.toString().replace(/[\uFB00-\uFB06]/g, value => value.normalize('NFKC'))); event.preventDefault();
  });
  let drag, textDrag, linkPress, sourcePointer = false, skipSelection = false;
  function point(event, record) {
    return sourcePoint(record.bounds, record.surface.getBoundingClientRect(), event.clientX, event.clientY);
  }
  function pointerDown(event, record) {
    linkPress = null;
    if (event.button !== 0 || event.target.closest('button') || !record.imageReady || !fresh(state.side, record.frame)) return;
    if (event.ctrlKey || event.metaKey) {
      sourcePointer = true; event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges();
      const [x, y] = point(event, record); send({ type: 'sourceJump', header: record.frame.header, session: record.frame.session, x, y }); return;
    }
    const link = state.tool === 'text' && referenceLinkAt(record.frame.header, ...point(event, record));
    if (link) linkPress = { record, start: point(event, record), payload: referencePayload(record, link) };
    if (state.tool !== 'region') {
      const start = point(event, record), index = Number(event.target.closest('[data-char-index]')?.dataset.charIndex);
      const line = record.lines?.find(line => line.glyphs.some(g => g.index === index)) || record.lines?.find(line => start[1] >= line.bounds[1] && start[1] <= line.bounds[3]);
      textDrag = line ? { record, anchor: { line, offset: lineCaret(line, start[0]) }, start, moved: false } : null;
      if (textDrag) { event.preventDefault(); record.paper.setPointerCapture(event.pointerId); setTextRange(textDrag, textDrag.anchor); }
      return;
    }
    drag = { record, start: point(event, record), current: point(event, record), frame: record.frame }; record.paper.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function pointerMove(event, record) {
    hoverReference(event, record);
    if (textDrag?.record === record && event.buttons & 1) {
      const end = point(event, record); if (Math.hypot(end[0] - textDrag.start[0], end[1] - textDrag.start[1]) > 2) textDrag.moved = true;
      event.preventDefault(); setTextRange(textDrag, textCaret(record.lines, end[0], end[1], textDrag.anchor.line));
    }
    if (!drag || drag.record !== record) return; drag.current = point(event, record); record.paper.querySelector('.selection-box')?.remove();
    const box = make('div', 'selection-box'); rectStyle(box, [Math.min(drag.start[0], drag.current[0]), Math.min(drag.start[1], drag.current[1]), Math.max(drag.start[0], drag.current[0]), Math.max(drag.start[1], drag.current[1])], record.bounds); record.surface.append(box);
  }
  function pointerUp(event, record) {
    if (linkPress?.record === record) {
      const pressed = linkPress, end = point(event, record); linkPress = null;
      if (Math.hypot(end[0] - pressed.start[0], end[1] - pressed.start[1]) < 3) {
        textDrag = null; if (record.paper.hasPointerCapture(event.pointerId)) record.paper.releasePointerCapture(event.pointerId);
        window.getSelection()?.removeAllRanges(); skipSelection = true; setTimeout(() => { skipSelection = false; }, 0);
        send({ ...pressed.payload, type: 'referenceJump' }); return;
      }
    }
    if (sourcePointer) { setTimeout(() => { sourcePointer = false; }, 0); return; }
    if (textDrag?.record === record) {
      const data = textDrag, end = point(event, record); textDrag = null;
      if (record.paper.hasPointerCapture(event.pointerId)) record.paper.releasePointerCapture(event.pointerId);
      setTextRange(data, textCaret(record.lines, end[0], end[1], data.anchor.line));
      if (data.moved) selectText(event, record);
      skipSelection = true; setTimeout(() => { skipSelection = false; }, 0); return;
    }
    if (!drag || drag.record !== record) return; const data = drag; drag = null; if (record.paper.hasPointerCapture(event.pointerId)) record.paper.releasePointerCapture(event.pointerId);
    const rect = [Math.min(data.start[0], data.current[0]), Math.min(data.start[1], data.current[1]), Math.max(data.start[0], data.current[0]), Math.max(data.start[1], data.current[1])];
    if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) return;
    const quote = (data.frame.header.characters || []).filter(c => c[0] !== 10 && c[1] < rect[2] && c[3] > rect[0] && c[2] < rect[3] && c[4] > rect[1]).map(c => c[0] ? String.fromCodePoint(c[0]) : '�').join(''); beginDraft(data.frame, [rect], quote, 'region');
  }
  function setTextRange(data, focus) {
    if (!focus) return;
    const caret = ({ line, offset }) => {
      const atEnd = offset >= line.glyphs.length, glyph = line.glyphs[atEnd ? line.glyphs.length - 1 : offset], node = data.record.charNodes.get(glyph.index)?.firstChild;
      return node ? { node, offset: atEnd ? node.textContent.length : 0 } : null;
    };
    const a = caret(data.anchor), b = caret(focus); if (a && b) window.getSelection()?.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
  }
  document.addEventListener('contextmenu', event => { if (event.ctrlKey && event.target.closest('.paper')) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') dismissReference();
    if (event.ctrlKey || event.metaKey) document.body.classList.add('source-modifier');
    if (['PageDown', 'PageUp'].includes(event.key) && !event.target.closest('textarea,input')) { event.preventDefault(); viewport.scrollBy(0, viewport.clientHeight * .9 * (event.key === 'PageDown' ? 1 : -1)); }
  });
  window.addEventListener('keyup', event => { if (!event.ctrlKey && !event.metaKey) document.body.classList.remove('source-modifier'); });
  window.addEventListener('blur', () => { document.body.classList.remove('source-modifier'); sourcePointer = false; });
  function difference(record) {
    record.paper.querySelector('.difference')?.remove(); const token = ++record.diffToken;
    if (!state.difference || !record.frame) return;
    let beforePage = record.page, afterPage = record.page;
    if (state.alignment) {
      const a = state.alignment.sourceSide === 'before' ? state.alignment.source : state.alignment.target, b = state.alignment.sourceSide === 'before' ? state.alignment.target : state.alignment.source;
      if ((state.side === 'before' ? a.page : b.page) === record.page) { beforePage = a.page; afterPage = b.page; }
    }
    const a = state.frames.before.get(beforePage), b = state.frames.after.get(afterPage);
    if (!a || !b) { enqueue(a ? 'after' : 'before', a ? afterPage : beforePage); return; }
    const before = new Image(), after = new Image(); let loaded = 0;
    const render = () => {
      if (++loaded !== 2 || token !== record.diffToken || !state.difference) return;
      const canvas = make('canvas', 'difference'); canvas.width = 1200; canvas.height = Math.round(1200 * (state.side === 'before' ? before : after).naturalHeight / (state.side === 'before' ? before : after).naturalWidth);
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); let dx = 0, dy = 0;
      if (state.alignment) {
        const first = state.alignment.sourceSide === 'before' ? state.alignment.source : state.alignment.target, second = state.alignment.sourceSide === 'before' ? state.alignment.target : state.alignment.source;
        if (first.bounds && second.bounds && first.page === beforePage && second.page === afterPage) {
          dx = ((first.x - first.bounds[0]) / (first.bounds[2] - first.bounds[0]) - (second.x - second.bounds[0]) / (second.bounds[2] - second.bounds[0])) * canvas.width;
          dy = ((first.y - first.bounds[1]) / (first.bounds[3] - first.bounds[1]) - (second.y - second.bounds[1]) / (second.bounds[3] - second.bounds[1])) * canvas.height;
        }
      }
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(before, state.side === 'after' ? -dx : 0, state.side === 'after' ? -dy : 0, canvas.width, canvas.height); const old = ctx.getImageData(0, 0, canvas.width, canvas.height);
      ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(after, state.side === 'before' ? dx : 0, state.side === 'before' ? dy : 0, canvas.width, canvas.height); const next = ctx.getImageData(0, 0, canvas.width, canvas.height), dest = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < old.data.length; i += 4) { const x = (old.data[i] + old.data[i + 1] + old.data[i + 2]) / 3, y = (next.data[i] + next.data[i + 1] + next.data[i + 2]) / 3; if (Math.abs(x - y) < 35) continue; dest.data[i] = x < y ? 228 : 13; dest.data[i + 1] = x < y ? 65 : 150; dest.data[i + 2] = x < y ? 75 : 125; dest.data[i + 3] = 205; }
      ctx.putImageData(dest, 0, 0); record.surface.append(canvas);
    };
    before.onload = render; after.onload = render; before.src = `data:${a.header.mime};base64,${a.data}`; after.src = `data:${b.header.mime};base64,${b.data}`;
  }
  const chatInput = document.querySelector('#chat-input'), chatAgent = document.querySelector('#chat-agent');
  const chatModel = document.querySelector('#chat-model'), chatEffort = document.querySelector('#chat-effort');
  let chatDraftTimer;
  const selectedOptions = () => ({ model: chatModel.value, effort: chatEffort.value });
  function renderModelControls(options = {}) {
    const catalog = state.chat?.catalogs[chatAgent.value] || { models: [], efforts: [] };
    const option = (value, label) => { const element = document.createElement('option'); element.value = value; element.textContent = label; return element; };
    chatModel.replaceChildren(option('', 'Default (agent settings)'), ...catalog.models.map(model => option(model.value, model.label)));
    if (options.model && !catalog.models.some(model => model.value === options.model)) chatModel.append(option(options.model, options.model));
    chatModel.append(option('__custom__', 'Other Model…')); chatModel.value = options.model || '';
    const efforts = catalog.models.find(model => model.value === chatModel.value)?.efforts || catalog.efforts;
    chatEffort.replaceChildren(option('', 'Default'), ...efforts.map(effort => option(effort, effort)));
    chatEffort.value = efforts.includes(options.effort) ? options.effort : '';
  }
  function saveChatDraft() { clearTimeout(chatDraftTimer); send({ type: 'chatDraft', text: chatInput.value, agent: chatAgent.value, options: selectedOptions() }); }
  function updateChatControls() {
    const chat = state.chat, notes = chat?.queuedNotes || [], ready = !!chatInput.value.trim() || notes.length > 0;
    document.querySelector('#send-chat').disabled = !chat || !ready || !!state.draft?.pending;
    document.querySelector('#send-chat').textContent = chat?.busy || chat?.paused ? 'Send and Queue' : 'Send';
    chatAgent.disabled = !!chat?.lockedAgent;
    document.querySelector('#new-session').disabled = !chat;
    document.querySelector('#stop-chat').hidden = !chat?.busy;
    document.querySelector('#resume-queue').hidden = !chat?.paused || !(chat?.tasks.length);
    document.querySelector('#toggle-manuscript').hidden = !chat?.hasTask;
    document.querySelector('#toggle-manuscript').textContent = chat?.direct ? 'View Changes' : chat?.view === 'after' ? 'Show Original' : 'Show Working Draft';
    document.querySelector('#undo-working').disabled = !!chat?.busy || !chat?.hasUndo;
    const turns = chat?.messages.filter(m => m.role === 'user').length || 0;
    document.querySelector('#session-status').textContent = chat?.paused ? 'Queue paused; subsequent tasks remain in this conversation.' : chat?.busy ? `Session running · Queue: ${chat.tasks.length}` : turns ? `Same session · ${turns} ${turns === 1 ? 'turn' : 'turns'} sent` : 'Select annotations in the sidebar to send them together.';
  }
  function renderAgentOutput(article, message) {
    const text = article.querySelector('.chat-message-text');
    text.textContent = message.text || (message.status === 'running' && !message.activities?.length ? 'Waiting for agent output…' : '');
    let activities = article.querySelector('.agent-activities');
    if (!activities && message.activities?.length) { activities = make('div', 'agent-activities'); article.append(activities); }
    for (const activity of message.activities || []) {
      let row = [...activities.children].find(child => child.dataset.activityId === activity.id);
      if (!row) {
        row = make('details', 'agent-activity'); row.dataset.activityId = activity.id;
        row.append(make('summary', 'activity-title'), make('pre', 'activity-input'), make('pre', 'activity-output')); activities.append(row);
      }
      row.dataset.status = activity.status;
      let detail = activity.input || '';
      try { const input = JSON.parse(detail); detail = input.file_path || input.path || input.command || input.pattern || input.description || ''; } catch {}
      const caption = `${activity.status === 'running' ? '●' : activity.status === 'failed' ? '×' : '✓'} ${activity.title}${detail ? ' · ' + detail.split('\n')[0].slice(0, 140) : ''}`;
      row.querySelector('summary').textContent = caption;
      for (const [selector, value] of [['.activity-input', activity.input], ['.activity-output', activity.output]]) {
        const content = row.querySelector(selector); content.hidden = !value;
        if (content.textContent !== (value || '')) content.textContent = value || '';
      }
    }
  }
  function renderChat(chat) {
    state.chat = chat;
    document.querySelector('#chat').setAttribute('aria-busy', String(chat.busy));
    const host = document.querySelector('#chat-messages'), bottom = host.scrollHeight - host.clientHeight - host.scrollTop < 50, oldTop = host.scrollTop;
    const expanded = new Set([...host.querySelectorAll('.agent-activity[open]')].map(row => `${row.closest('.chat-message').dataset.messageId}:${row.dataset.activityId}`));
    host.replaceChildren();
    if (!chat.messages.length) { const welcome = make('div', 'chat-welcome'); welcome.append(make('div', 'welcome-symbol', '✦'), make('h2', '', 'What would you like to revise?'), make('p', '', 'Annotate the PDF or describe your revision below.')); host.append(welcome); }
    for (const message of chat.messages) {
      const article = make('article', `chat-message ${message.role} ${message.status || ''}`); article.dataset.messageId = message.id;
      if (message.role !== 'system') article.append(make('div', 'chat-author', message.role === 'user' ? 'You' : chat.agentName || (chat.agent === 'claude' ? 'Claude Code' : 'Codex')));
      article.append(make('div', 'chat-message-text'));
      renderAgentOutput(article, message);
      for (const row of article.querySelectorAll('.agent-activity')) row.open = expanded.has(`${message.id}:${row.dataset.activityId}`);
      for (const note of message.notes || []) { const chip = action(`Page ${note.page + 1} · ${note.comment}`, () => send({ type: 'revealNote', id: note.id }), 'message-note'); chip.title = note.comment; article.append(chip); }
      if (message.status === 'queued') article.append(make('small', 'message-status', 'Queued'));
      if (message.status === 'running') article.append(make('small', 'message-status', 'Running…'));
      if (message.status === 'interrupted') article.append(make('small', 'message-status', 'The previous run was interrupted. Continue in this session.'));
      host.append(article);
    }
    if (bottom) host.scrollTop = host.scrollHeight; else host.scrollTop = oldTop;
    const notes = document.querySelector('#queued-notes'); notes.replaceChildren();
    if (chat.queuedNotes.length) notes.append(make('div', 'queue-heading', `Draft Annotations · ${chat.queuedNotes.length}`));
    for (const note of chat.queuedNotes) {
      const row = make('div', 'queued-note'); row.dataset.noteId = note.id;
      const label = action(`Page ${note.page + 1} · ${note.comment}`, () => send({ type: 'revealNote', id: note.id }), 'queued-note-label'); label.title = note.comment;
      const remove = action('×', () => send({ type: 'removeQueuedNote', id: note.id }), 'remove-queued-note'); remove.setAttribute('aria-label', 'Remove this annotation from the draft');
      row.append(label, remove); notes.append(row);
    }
    const tasks = document.querySelector('#task-queue'); tasks.replaceChildren(); tasks.hidden = !chat.tasks.length;
    if (chat.tasks.length) tasks.append(make('div', 'queue-heading', `Queued Tasks · ${chat.tasks.length}`));
    for (const task of chat.tasks) {
      const row = make('div', 'queued-turn'); row.dataset.turnId = task.id;
      row.append(make('span', '', task.text || `${task.count}  PDF Annotations`), action('×', () => send({ type: 'removeQueuedTurn', id: task.id }))); tasks.append(row);
    }
    if (document.activeElement !== chatInput) chatInput.value = chat.draft || '';
    chatAgent.replaceChildren(...chat.agents.map(profile => { const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name; option.title = profile.claude_config_dir || profile.command; return option; }));
    const addAgent = document.createElement('option'); addAgent.value = '__add_claude__'; addAgent.textContent = '＋ Add Claude Agent…'; chatAgent.append(addAgent);
    chatAgent.value = chat.agent; renderModelControls(chat.runOptions); updateChatControls(); renderAnnotation();
  }
  function sendChat(ids) {
    if (document.querySelector('#send-chat').disabled) return;
    closeAnnotation(); document.querySelector('#chat-error').hidden = true;
    clearTimeout(chatDraftTimer);
    send({ type: 'chatSend', instruction: chatInput.value, agent: chatAgent.value, ids: Array.isArray(ids) ? ids : (state.chat?.queuedNotes || []).map(n => n.id), options: selectedOptions() });
  }
  chatInput.oninput = () => { updateChatControls(); clearTimeout(chatDraftTimer); chatDraftTimer = setTimeout(saveChatDraft, 150); };
  let composing = false;
  chatInput.oncompositionstart = () => { composing = true; }; chatInput.oncompositionend = () => { composing = false; };
  chatInput.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !composing && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat) sendChat(); }
  };
  chatAgent.onchange = () => { if (chatAgent.value === '__add_claude__') { chatAgent.value = state.chat.agent; send({ type: 'addAgent' }); } else { renderModelControls(); saveChatDraft(); } };
  chatModel.onchange = () => {
    if (chatModel.value === '__custom__') { chatModel.value = state.chat.runOptions?.model || ''; saveChatDraft(); send({ type: 'chooseModel' }); }
    else { renderModelControls(selectedOptions()); saveChatDraft(); }
  };
  chatEffort.onchange = saveChatDraft;
  document.querySelector('#send-chat').onclick = sendChat;
  document.querySelector('#new-session').onclick = () => { document.querySelector('#chat-error').hidden = true; send({ type: 'newSession' }); };
  document.querySelector('#resume-queue').onclick = () => send({ type: 'resumeQueue' });
  document.querySelector('#stop-chat').onclick = () => send({ type: 'stopQueue' });
  const logs = action('Logs', () => send({ type: 'showLogs' })); document.querySelector('.chat-header').append(logs);
  const undo = action('Undo Round', () => send({ type: 'undoWorkingChanges' })); undo.id = 'undo-working'; document.querySelector('.chat-header').append(undo);
  const toggle = action('Show Original', () => send({ type: 'toggleManuscript' })); toggle.id = 'toggle-manuscript'; toggle.hidden = true; document.querySelector('.chat-header').append(toggle);
  updateChatControls();
  let sourceLocationTimer;
  window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'init') {
      documentState = { ...documentState, root: message.root, main: message.main, page: message.chatOnly ? documentState.page || 0 : message.page || 0 }; vscode.setState(documentState);
      Object.assign(state, { side: message.side, tool: message.tool, zoom: message.zoom, notes: message.notes, difference: message.difference, markers: message.markers || state.markers });
      document.body.classList.toggle('secondary', message.chatVisible === false); document.body.classList.toggle('chat-only', !!message.chatOnly); document.body.dataset.side = state.side; document.body.style.setProperty('--zoom', state.zoom); ensureRows(); for (const record of state.rows.values()) record.paper.dataset.side = state.side;
    } else if (message.type === 'previewReset') {
      dismissReference(); referenceCache.clear();
      state.meta[message.side] = null; state.frames[message.side].clear(); state.queue = state.queue.filter(r => r.side !== message.side); for (const id of [...state.queued]) if (id.startsWith(message.side + ':')) state.queued.delete(id);
      if (state.pending?.side === message.side) state.pending = null;
      if (message.side === state.side) for (const record of state.rows.values()) { record.renderKey = ''; record.paper.classList.add('stale'); }
    } else if (message.type === 'previewState') {
      const previous = state.meta[message.side]; state.meta[message.side] = { ...message, pages: !message.complete && previous?.session === message.session && previous?.sequence === message.sequence ? Math.max(previous.pages, message.pages) : message.pages };
      if (message.side === state.side && previous && (previous.sequence !== message.sequence || previous.revision !== message.revision)) { dismissReference(); referenceCache.clear(); }
      if (!previous || previous.session !== message.session || previous.sequence !== message.sequence || previous.revision !== message.revision) for (const id of [...state.failed]) if (id.startsWith(message.side + ':')) state.failed.delete(id);
      if (message.side === state.side) { ensureRows(); for (const record of state.rows.values()) record.paper.classList.toggle('stale', !fresh(state.side, record.frame)); requestVisible(); }
      pump();
    } else if (message.type === 'frame' || message.type === 'pageFrame') {
      putFrame(message);
      if (message.type === 'pageFrame' && state.pending?.key === key(message.side, message.header.page, message.session)) state.pending = null;
      pump();
    } else if (message.type === 'pageError') {
      if (message.session !== state.meta[message.side]?.session) return;
      state.failed.add(key(message.side, message.page, message.session));
      if (state.pending?.key === key(message.side, message.page, message.session)) state.pending = null;
      const record = state.rows.get(message.page); if (message.side === state.side && record && !record.frame) { const failure = make('div', 'page-failure'); failure.append(make('p', '', message.message), action('Reload Page', () => enqueue(state.side, message.page, true))); record.paper.replaceChildren(failure); }
      pump();
    } else if (message.type === 'referencePreview') {
      void renderReference(message).catch(error => { if (hoveredReference?.payload.requestId === message.requestId) { referenceContent.replaceChildren(make('p', '', String(error))); positionReference(); } });
    } else if (message.type === 'referenceImage') {
      void renderReferenceImage(message).catch(error => { if (hoveredReference?.payload.requestId === message.requestId) { referenceContent.replaceChildren(make('p', '', String(error))); positionReference(); } });
    } else if (message.type === 'referencePosition') {
      if (message.side === state.side && message.session === state.meta[state.side]?.session) {
        const target = message.target; dismissReference(); state.pendingReveal = { page: target.page, rect: [target.x, target.y, target.x + 1, target.y + 12] }; ensureRows(target.page + 1); enqueue(state.side, target.page); reveal();
      }
    } else if (message.type === 'notes') {
      const previous = state.notes.find(n => n.id === state.openNote), opened = message.notes.find(n => n.id === state.openNote);
      state.notes = message.notes; updateRailVisibility(); for (const record of state.rows.values()) { renderCards(record); if (record.frame) drawMarks(record); }
      if (opened?.status && opened.status !== 'open') { state.openNote = null; renderAnnotation(); }
      if (opened && previous?.page !== opened.page) { state.pendingReveal = { page: opened.page, rect: opened.rects[0] }; ensureRows(opened.page + 1); enqueue(state.side, opened.page); reveal(); }
    } else if (message.type === 'annotationSaved') {
      if (state.draft?.id === message.draftId) { const page = state.draft.page, hidden = state.draft.hidden; state.draft = null; if (!hidden) { state.focusedNote = message.id; state.openNote = message.id; } const record = state.rows.get(page); if (record?.frame) drawMarks(record); renderAnnotation(); updateChatControls(); }
    } else if (message.type === 'annotationError') annotationError(message);
    else if (message.type === 'noteEdited') { state.edits.delete(message.id); renderAnnotation(); }
    else if (message.type === 'editNote') { const note = state.notes.find(n => n.id === message.id); if (note) beginEdit(note); }
    else if (message.type === 'beginDraft') { const frame = { header: message.header, session: message.session }; beginDraft(frame, message.rects, message.quote, message.kind, { editing: true }); }
    else if (message.type === 'tool') { state.tool = message.tool; for (const record of state.rows.values()) record.paper.classList.toggle('region-mode', state.tool === 'region'); }
    else if (message.type === 'zoom') { dismissReference(); state.zoom = message.zoom; document.body.style.setProperty('--zoom', state.zoom); }
    else if (message.type === 'difference') { state.difference = message.enabled; for (const record of state.rows.values()) if (record.frame) difference(record); }
    else if (message.type === 'markers') { state.markers = message.markers; if (state.openReview && !state.markers[state.side].some(marker => marker.id === state.openReview.id)) state.openReview = null; for (const record of state.rows.values()) if (record.frame) drawMarks(record); renderAnnotation(); }
    else if (message.type === 'reviewDetails') { closeAnnotation(); state.openReview = message; renderAnnotation(); }
    else if (message.type === 'reviewDecisionDone' || message.type === 'dismissReview') { if (!message.id || state.openReview?.id === message.id) { state.openReview = null; renderAnnotation(); } }
    else if (message.type === 'reviewError' && state.openReview?.id === message.id) { state.openReview.error = message.message; state.openReview.pending = false; renderAnnotation(); }
    else if (message.type === 'decisions') { for (const list of Object.values(state.markers)) for (const marker of list) { const edit = message.edits.find(e => e.id === marker.id); if (edit) marker.decision = edit.decision; } for (const record of state.rows.values()) if (record.frame) drawMarks(record); }
    else if (message.type === 'chatState') renderChat(message);
    else if (message.type === 'sendSelectedNotes') sendChat(message.ids);
    else if (message.type === 'agentOutput') {
      const response = state.chat?.messages.find(item => item.id === message.id); if (!response) return;
      response.text = message.text; response.activities = message.activities;
      const host = document.querySelector('#chat-messages'), bottom = host.scrollHeight - host.clientHeight - host.scrollTop < 50;
      const article = [...host.querySelectorAll('.chat-message')].find(item => item.dataset.messageId === message.id); if (article) renderAgentOutput(article, response);
      if (bottom) host.scrollTop = host.scrollHeight;
    }
    else if (message.type === 'chatSent') { const input = document.querySelector('#chat-input'); if (input.value === message.instruction) input.value = ''; updateChatControls(); }
    else if (message.type === 'chatError') { document.querySelector('#chat-error').textContent = message.message; document.querySelector('#chat-error').hidden = false; updateChatControls(); }
    else if (message.type === 'focusChat') {
      if (typeof message.draft === 'string') {
        clearTimeout(chatDraftTimer); chatInput.value = message.draft;
        document.querySelector('#chat-error').hidden = true; updateChatControls(); saveChatDraft();
      }
      chatInput.focus(); chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    }
    else if (message.type === 'navigate') navigate(message.page);
    else if (message.type === 'sourcePosition') {
      clearTimeout(sourceLocationTimer); state.sourceLocation = message;
      state.pendingReveal = { page: message.page, rect: message.rects[0] }; ensureRows(message.page + 1); enqueue(state.side, message.page); reveal();
      for (const record of state.rows.values()) if (record.frame) drawMarks(record);
      sourceLocationTimer = setTimeout(() => { state.sourceLocation = null; for (const record of state.rows.values()) if (record.frame) drawMarks(record); }, 3000);
    }
    else if (message.type === 'reveal') { state.pendingReveal = message; ensureRows((message.page || 0) + 1); reveal(); if (message.noteId) openNote(message.noteId); }
    else if (message.type === 'selectedEdit') { state.selectedEdit = message.id; for (const record of state.rows.values()) if (record.frame) drawMarks(record); }
    else if (message.type === 'alignment') { state.alignment = message; for (const record of state.rows.values()) if (record.frame) difference(record); }
    else if (message.type === 'alignmentUnavailable') { state.alignment = null; for (const record of state.rows.values()) if (record.frame) difference(record); }
    else if (message.type === 'reportVisiblePage') { onScroll(); requestAnimationFrame(() => send({ type: 'visiblePage', page: state.currentPage })); }
    else if (message.type === 'error') { const loading = pages.querySelector('.page-loading'); if (loading) loading.textContent = message.message; }
  });
  ensureRows(); send({ type: 'ready' });
})();
