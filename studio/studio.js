// Pitch Studio front end. Slides render in a same-origin iframe at 1920x1080;
// everything you point at is stored as canvas-pixel coordinates in feedback.json.
(() => {
  const W = 1920, H = 1080;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    deck: null,         // deck.json contents
    feedback: [],
    current: null,      // slide id, or 'sketch:<feedback id>' for a new-slide sketch
    mode: 'view',
    scope: 'slide',
    status: 'open',
    scale: 1,
    hover: null,        // { el, rect } under the pointer
    selected: null,     // adjust: { el, selector, orig, rect, itemId }
    selBlock: null,     // block id
    activeItem: null,   // feedback id highlighted in the panel
    popover: null,      // comment draft
  };

  const frame = $('#slideFrame');
  const canvas = $('#canvas');
  const overlay = $('#overlay');
  const stage = $('#stage');

  const HINTS = {
    view: 'Viewing. Press C to comment, A to move & resize, B to sketch layout blocks. ← → change slides, F toggles feedback.',
    comment: 'Click any element to comment on it. In the popover, ↑ selects the parent element.',
    adjust: 'Drag an element to move it, drag a handle to resize. Arrow keys nudge (Shift = 10px). Delete reverts.',
    block: 'Drag on the slide to draw a block, then name it ("logo", "big number"). Claude builds the slide to match.',
  };

  // ---------- api ----------
  const api = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  };
  const fbUrl = (id = '') => `/api/decks/${state.deck.id}/feedback${id ? '/' + id : ''}`;

  let lastLocalWrite = 0;
  async function saveItem(method, id, body) {
    lastLocalWrite = Date.now();
    const item = await api(method, fbUrl(id), body);
    if (method === 'POST') state.feedback.push(item);
    else if (method === 'DELETE') state.feedback = state.feedback.filter((f) => f.id !== id);
    else Object.assign(state.feedback.find((f) => f.id === id), item);
    return item;
  }

  // ---------- helpers ----------
  const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
  const doc = () => frame.contentDocument;
  const slideRoot = () => doc()?.querySelector('section.slide');
  const isSketch = () => state.current?.startsWith('sketch:');
  const sketchItem = () => isSketch() && state.feedback.find((f) => f.id === state.current.slice(7));

  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
  }
  function place(el, r) {
    const s = state.scale;
    Object.assign(el.style, { left: r.x * s + 'px', top: r.y * s + 'px', width: r.w * s + 'px', height: r.h * s + 'px' });
  }
  function elRect(el) {
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }

  // A stable way to find the element again after Claude rewrites the slide.
  function selectorFor(el) {
    if (el.dataset.el) return `[data-el="${el.dataset.el}"]`;
    const root = slideRoot();
    if (el === root) return 'section.slide';
    const path = [];
    let node = el;
    while (node && node !== root && node.nodeType === 1) {
      const named = node.dataset?.el;
      if (named) { path.unshift(`[data-el="${named}"]`); break; }
      const same = [...node.parentElement.children].filter((c) => c.tagName === node.tagName);
      path.unshift(node.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''));
      node = node.parentElement;
    }
    return (node === root ? 'section.slide > ' : '') + path.join(' > ');
  }
  function labelFor(el) {
    if (el.dataset.el) return el.dataset.el;
    if (el === slideRoot()) return 'whole slide';
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return `<${el.tagName.toLowerCase()}>` + (txt ? ` "${txt.slice(0, 28)}${txt.length > 28 ? '…' : ''}"` : '');
  }
  function findEl(selector) {
    try { return doc()?.querySelector(selector) || null; } catch { return null; }
  }
  function targetOf(el) {
    return {
      el: el.dataset.el || null,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      rect: round(elRect(el)),
    };
  }
  // Nearest meaningful element under a canvas point: prefer named [data-el] ancestors.
  function hitTest(p) {
    const d = doc();
    if (!d) return null;
    let el = d.elementFromPoint(p.x, p.y);
    if (!el || el === d.body || el === d.documentElement) return null;
    return el.closest('[data-el]') || el;
  }

  // ---------- deck + slides ----------
  async function loadDeck(id) {
    state.deck = await api('GET', `/api/decks/${id}`);
    state.feedback = await api('GET', fbUrl());
    $('#deckTitle').textContent = state.deck.title || id;
    document.title = `${state.deck.title || id} · Pitch Studio`;
    if (!state.current || !slideOrder().includes(state.current)) state.current = slideOrder()[0] || null;
    renderStrip();
    showSlide(state.current);
    renderPanel();
  }

  // Real slides plus new-slide sketches, in deck order.
  function slideOrder() {
    const order = [];
    const sketches = state.feedback.filter((f) => f.type === 'layout' && !f.slide && f.status === 'open');
    const after = (id) => sketches.filter((s) => s.insertAfter === id).forEach((s) => order.push('sketch:' + s.id));
    after(null);
    for (const id of state.deck.slides) { order.push(id); after(id); }
    sketches.filter((s) => s.insertAfter && !state.deck.slides.includes(s.insertAfter) && !order.includes('sketch:' + s.id))
      .forEach((s) => order.push('sketch:' + s.id));
    return order;
  }

  function renderStrip() {
    const list = $('#slideList');
    const order = slideOrder();
    let n = 0;
    list.replaceChildren(...order.map((id) => {
      const li = document.createElement('li');
      li.className = 'thumb';
      li.dataset.id = id;
      li.setAttribute('aria-current', String(id === state.current));
      if (id.startsWith('sketch:')) {
        li.classList.add('ghost');
        li.innerHTML = `<span class="n">+</span><div class="frame">Sketch</div>`;
      } else {
        n += 1;
        const open = state.feedback.filter((f) => f.slide === id && f.status === 'open').length;
        li.innerHTML = `<span class="n">${n}</span><div class="frame"><iframe loading="lazy" tabindex="-1" src="/render/${state.deck.id}/${id}"></iframe>${open ? `<span class="badge">${open}</span>` : ''}</div>`;
      }
      li.addEventListener('click', () => showSlide(id));
      return li;
    }));
  }

  function refreshThumb(id) {
    const f = $(`.thumb[data-id="${id}"] iframe`);
    if (f) f.src = `/render/${state.deck.id}/${id}?t=${Date.now()}`;
  }

  function showSlide(id) {
    state.current = id;
    state.selected = null; state.selBlock = null; closePopover();
    $$('.thumb').forEach((t) => t.setAttribute('aria-current', String(t.dataset.id === id)));
    $(`.thumb[data-id="${CSS.escape(id || '')}"]`)?.scrollIntoView({ block: 'nearest' });
    const sketch = isSketch();
    $('#sketchGround').hidden = !sketch;
    frame.hidden = sketch;
    if (sketch) { if (state.mode !== 'block') setMode('block'); drawOverlay(); renderPanel(); return; }
    if (id) reloadFrame();
    renderPanel();
  }

  function reloadFrame() {
    if (!state.current || isSketch()) return;
    frame.src = `/render/${state.deck.id}/${state.current}?t=${Date.now()}`;
  }
  frame.addEventListener('load', () => {
    applyAdjustPreviews();
    drawOverlay();
    // Fonts and images can shift layout after load; redraw once they settle.
    doc()?.fonts?.ready.then(drawOverlay);
  });

  // Open move/resize instructions are previewed on the slide until Claude applies them.
  function applyAdjustPreviews() {
    for (const it of itemsFor(state.current)) {
      if (it.type !== 'adjust' || it.status !== 'open' || !it.to) continue;
      const el = findEl(it.target.selector);
      if (el) previewAdjust(el, it.target.rect, it.to);
    }
  }
  function previewAdjust(el, orig, to) {
    el.style.translate = `${to.x - orig.x}px ${to.y - orig.y}px`;
    if (Math.round(to.w) !== Math.round(orig.w) || Math.round(to.h) !== Math.round(orig.h)) {
      el.style.boxSizing = 'border-box';
      el.style.width = to.w + 'px';
      el.style.height = to.h + 'px';
      el.style.maxWidth = 'none';
    }
  }

  // ---------- fit ----------
  function fit() {
    const pad = 40;
    const r = stage.getBoundingClientRect();
    state.scale = Math.max(0.1, Math.min((r.width - pad * 2) / W, (r.height - pad * 2) / H));
    canvas.style.width = W * state.scale + 'px';
    canvas.style.height = H * state.scale + 'px';
    frame.style.transform = `scale(${state.scale})`;
    drawOverlay();
  }
  new ResizeObserver(fit).observe(stage);

  // ---------- modes ----------
  function setMode(mode) {
    if (isSketch() && mode !== 'block') return toast('A sketched slide only has Block mode until Claude builds it.');
    state.mode = mode;
    document.body.dataset.mode = mode;
    $$('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    state.hover = null; state.selected = null; state.selBlock = null;
    closePopover();
    $('#hint').textContent = HINTS[mode];
    drawOverlay();
  }
  $$('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------- overlay drawing ----------
  function itemsFor(slide) { return state.feedback.filter((f) => f.slide === slide); }
  function layoutItem() {
    return isSketch() ? sketchItem() : state.feedback.find((f) => f.type === 'layout' && f.slide === state.current && f.status === 'open');
  }

  function drawOverlay() {
    overlay.replaceChildren();
    if (!state.deck || !state.current) return;
    const s = state.scale;

    // hover highlight (comment + adjust)
    if (state.hover && (state.mode === 'comment' || state.mode === 'adjust') && state.hover.el !== state.selected?.el) {
      overlay.append(highlight(state.hover.rect, labelFor(state.hover.el)));
    }

    // popover target stays highlighted
    if (state.popover) overlay.append(highlight(state.popover.target.rect, state.popover.label));

    // pins for comments and adjustments
    const numbered = numberedItems();
    for (const it of itemsFor(state.current)) {
      if (it.type === 'layout' || it.status !== state.status) continue;
      const live = it.target?.selector && !isSketch() ? findEl(it.target.selector) : null;
      const r = it.type === 'adjust' && it.to ? it.to : live ? elRect(live) : it.target?.rect;
      if (!r) continue;
      const pin = document.createElement('button');
      pin.className = `pin ${it.type}` + (it.id === state.activeItem ? ' active' : '') + (!live && it.type === 'comment' ? ' stale' : '');
      pin.textContent = numbered.get(it.id);
      pin.title = it.comment || (it.type === 'adjust' ? 'Move / resize' : 'Comment');
      pin.style.left = Math.min(W - 14, r.x + r.w) * s + 'px';
      pin.style.top = Math.max(14, r.y) * s + 'px';
      pin.addEventListener('pointerdown', (e) => e.stopPropagation());
      pin.addEventListener('click', (e) => { e.stopPropagation(); focusItem(it.id); });
      overlay.append(pin);
    }

    // adjust selection
    if (state.mode === 'adjust' && state.selected) {
      const ghost = document.createElement('div');
      ghost.className = 'ghost-orig';
      place(ghost, state.selected.orig);
      overlay.append(ghost);
      const box = document.createElement('div');
      box.className = 'box sel';
      place(box, state.selected.rect);
      box.append(...handles());
      box.addEventListener('pointerdown', (e) => startDrag(e, 'move'));
      overlay.append(box);
    }

    // layout blocks
    const layer = document.createElement('div');
    layer.className = 'blocks-layer';
    for (const b of layoutItem()?.blocks || []) layer.append(blockEl(b));
    overlay.append(layer);

    if (state.popover) overlay.append(state.popover.node);
  }

  function highlight(r, label) {
    const hl = document.createElement('div');
    hl.className = 'hl' + (r.y < 40 ? ' below' : '');
    place(hl, r);
    const tag = document.createElement('span');
    tag.className = 'hl-label';
    tag.textContent = label;
    hl.append(tag);
    return hl;
  }
  function handles() {
    return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => {
      const d = document.createElement('div');
      d.className = 'h';
      d.dataset.h = h;
      return d;
    });
  }

  // ---------- pointer handling ----------
  overlay.addEventListener('pointermove', (e) => {
    const p = toCanvas(e);
    $('#coords').textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
    if (drag || state.popover || isSketch()) return;
    if (state.mode !== 'comment' && state.mode !== 'adjust') return;
    const el = hitTest(p);
    const prev = state.hover?.el;
    state.hover = el ? { el, rect: elRect(el) } : null;
    if (el !== prev) drawOverlay();
  });
  overlay.addEventListener('pointerleave', () => {
    $('#coords').textContent = '';
    if (state.hover && !drag) { state.hover = null; drawOverlay(); }
  });

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = toCanvas(e);
    if (state.mode === 'comment') {
      if (state.popover) return closePopover();
      const el = hitTest(p) || slideRoot();
      if (el) openPopover(el);
    } else if (state.mode === 'adjust') {
      const el = hitTest(p);
      if (!el || el === slideRoot()) { state.selected = null; drawOverlay(); return; }
      selectForAdjust(el);
      startDrag(e, 'move');
    } else if (state.mode === 'block') {
      state.selBlock = null;
      startDraw(e, p);
    }
  });

  // ---------- comment popover ----------
  function openPopover(el) {
    const target = targetOf(el);
    const node = document.createElement('div');
    node.className = 'pop';
    node.innerHTML = `
      <div class="pop-head">
        <code></code>
        <button class="icon-btn" data-act="parent" title="Select parent element"><svg><use href="#i-parent"/></svg></button>
        <button class="icon-btn" data-act="close" title="Cancel (Esc)"><svg><use href="#i-close"/></svg></button>
      </div>
      <textarea placeholder="What should change? e.g. &quot;too corporate, make it blunter&quot;"></textarea>
      <div class="pop-foot"><span class="tip">Ctrl+Enter to save</span><button class="btn btn-primary" data-act="save">Add comment</button></div>`;
    $('code', node).textContent = labelFor(el);
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    const ta = $('textarea', node);
    ta.spellcheck = false;
    if (state.popover) ta.value = $('textarea', state.popover.node).value;
    node.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') closePopover();
      if (act === 'save') submitComment();
      if (act === 'parent') {
        const parent = el.parentElement?.closest('[data-el]') || el.parentElement;
        if (parent && parent !== doc().body) openPopover(parent);
      }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment();
      if (e.key === 'Escape') closePopover();
    });
    state.popover = { node, target, label: labelFor(el) };
    // Anchor below the target, flipped above or inward when it would leave the canvas.
    const s = state.scale, r = target.rect;
    const pw = 320, ph = 190;
    let left = r.x * s, top = (r.y + r.h) * s + 8;
    if (top + ph > H * s) top = Math.max(8, r.y * s - ph - 8);
    left = Math.min(Math.max(8, left), W * s - pw - 8);
    Object.assign(node.style, { left: left + 'px', top: top + 'px' });
    state.hover = null;
    drawOverlay();
    ta.focus();
  }
  function closePopover() {
    if (!state.popover) return;
    state.popover = null;
    drawOverlay();
  }
  async function submitComment() {
    const pop = state.popover;
    const comment = $('textarea', pop.node).value.trim();
    if (!comment) return $('textarea', pop.node).focus();
    try {
      const item = await saveItem('POST', '', { type: 'comment', slide: state.current, target: pop.target, comment });
      state.popover = null;
      state.activeItem = item.id;
      afterFeedbackChange();
    } catch (err) { toast(`Comment not saved: ${err.message}`, true); }
  }

  // ---------- adjust (move / resize) ----------
  function selectForAdjust(el) {
    const selector = selectorFor(el);
    const existing = state.feedback.find((f) => f.type === 'adjust' && f.status === 'open' && f.slide === state.current && f.target.selector === selector);
    // getBoundingClientRect includes any preview already applied, so the original rect comes from the item.
    const orig = existing ? existing.target.rect : round(elRect(el));
    state.selected = { el, selector, orig, rect: existing?.to ? { ...existing.to } : { ...orig }, itemId: existing?.id || null };
    state.hover = null;
    if (existing) state.activeItem = existing.id;
  }

  let drag = null;
  function startDrag(e, kind) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.closest('.h')?.dataset.h;
    const target = state.mode === 'block' ? blockById(state.selBlock) : state.selected;
    if (!target) return;
    const base = state.mode === 'block' ? { x: target.x, y: target.y, w: target.w, h: target.h } : { ...state.selected.rect };
    drag = { kind: handle ? 'resize' : kind, handle, start: toCanvas(e), base, moved: false };
    overlay.setPointerCapture(e.pointerId);
  }

  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toCanvas(e);
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.kind === 'draw') return updateDraw(p);
    const r = resizeRect(drag.base, drag.kind === 'move' ? null : drag.handle, dx, dy, e.shiftKey);
    applyRect(r);
  });
  overlay.addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    overlay.releasePointerCapture?.(e.pointerId);
    if (d.kind === 'draw') return finishDraw();
    if (!d.moved) { drawOverlay(); return; }
    if (state.mode === 'adjust') await commitAdjust();
    else await saveBlocks();
  });

  function resizeRect(b, h, dx, dy, keepRatio) {
    let { x, y, w, h: hh } = b;
    if (!h) return { x: x + dx, y: y + dy, w, h: hh };
    if (h.includes('e')) w = b.w + dx;
    if (h.includes('s')) hh = b.h + dy;
    if (h.includes('w')) { w = b.w - dx; x = b.x + dx; }
    if (h.includes('n')) { hh = b.h - dy; y = b.y + dy; }
    if (keepRatio && h.length === 2) {
      const ratio = b.w / b.h;
      if (w / hh > ratio) w = hh * ratio; else hh = w / ratio;
      if (h.includes('w')) x = b.x + b.w - w;
      if (h.includes('n')) y = b.y + b.h - hh;
    }
    w = Math.max(16, w); hh = Math.max(16, hh);
    return { x, y, w, h: hh };
  }

  function applyRect(r) {
    r = round(r);
    if (state.mode === 'adjust') {
      state.selected.rect = r;
      previewAdjust(state.selected.el, state.selected.orig, r);
    } else {
      Object.assign(blockById(state.selBlock), r);
    }
    drawOverlay();
  }

  async function commitAdjust() {
    const sel = state.selected;
    try {
      if (sel.itemId) {
        await saveItem('PATCH', sel.itemId, { to: sel.rect });
      } else {
        const target = { ...targetOf(sel.el), rect: sel.orig };
        const item = await saveItem('POST', '', { type: 'adjust', slide: state.current, target, to: sel.rect, comment: '' });
        sel.itemId = item.id;
        state.activeItem = item.id;
      }
      afterFeedbackChange();
    } catch (err) { toast(`Move not saved: ${err.message}`, true); }
  }

  async function revertAdjust() {
    if (!state.selected?.itemId) { state.selected = null; return drawOverlay(); }
    await saveItem('DELETE', state.selected.itemId);
    state.selected = null;
    reloadFrame();
    afterFeedbackChange();
  }

  // ---------- blocks ----------
  function blockById(id) { return layoutItem()?.blocks.find((b) => b.id === id); }

  function startDraw(e, p) {
    e.preventDefault();
    drag = { kind: 'draw', start: p, moved: false };
    const d = document.createElement('div');
    d.className = 'drawing';
    overlay.append(d);
    drag.node = d;
    overlay.setPointerCapture(e.pointerId);
  }
  function updateDraw(p) {
    const s = drag.start;
    drag.rect = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    lastDraw = drag.rect;
    place(drag.node, drag.rect);
  }
  async function finishDraw() {
    const r = drawRectFrom();
    if (!r) { drawOverlay(); return; }
    const block = { id: 'b' + Math.random().toString(36).slice(2, 7), label: '', ...round(r) };
    let item = layoutItem();
    try {
      if (item) {
        item.blocks.push(block);
        await saveBlocks();
      } else {
        item = await saveItem('POST', '', { type: 'layout', slide: state.current, blocks: [block], comment: '' });
        afterFeedbackChange();
      }
      state.selBlock = block.id;
      drawOverlay();
      $(`.block[data-id="${block.id}"] input`)?.focus();
    } catch (err) { toast(`Block not saved: ${err.message}`, true); }
  }
  // finishDraw runs after drag is cleared, so the last drawn rect is kept here.
  let lastDraw = null;
  function drawRectFrom() {
    const r = lastDraw;
    lastDraw = null;
    return r && r.w >= 24 && r.h >= 24 ? r : null;
  }

  function blockEl(b) {
    const el = document.createElement('div');
    el.className = 'block box' + (b.id === state.selBlock ? ' sel' : '');
    el.dataset.id = b.id;
    place(el, b);
    el.innerHTML = `<input placeholder="Name this block" aria-label="Block label"><button class="x" title="Delete block"><svg><use href="#i-close"/></svg></button><span class="dims">${Math.round(b.w)}×${Math.round(b.h)}</span>`;
    el.append(...handles());
    const input = $('input', el);
    input.value = b.label;
    input.addEventListener('pointerdown', (e) => { e.stopPropagation(); state.selBlock = b.id; });
    input.addEventListener('input', () => { b.label = input.value; saveBlocksSoon(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
    $('.x', el).addEventListener('pointerdown', (e) => e.stopPropagation());
    $('.x', el).addEventListener('click', () => deleteBlock(b.id));
    el.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'block') return;
      state.selBlock = b.id;
      if (!e.target.closest('.h')) drawOverlay();
      startDrag(e, 'move');
    });
    return el;
  }

  let blockTimer = null;
  function saveBlocksSoon() {
    clearTimeout(blockTimer);
    blockTimer = setTimeout(saveBlocks, 400);
  }
  async function saveBlocks() {
    const item = layoutItem();
    if (!item) return;
    try { await saveItem('PATCH', item.id, { blocks: item.blocks }); renderPanel(); }
    catch (err) { toast(`Blocks not saved: ${err.message}`, true); }
  }
  async function deleteBlock(id) {
    const item = layoutItem();
    if (!item) return;
    item.blocks = item.blocks.filter((b) => b.id !== id);
    state.selBlock = null;
    // An empty sketch on an existing slide is just noise; a new-slide sketch stays until deleted from the panel.
    if (!item.blocks.length && item.slide) await saveItem('DELETE', item.id);
    else await saveBlocks();
    afterFeedbackChange();
  }

  $('#sketchNew').addEventListener('click', async () => {
    const after = isSketch() ? sketchItem()?.insertAfter ?? null : state.current;
    try {
      const item = await saveItem('POST', '', { type: 'layout', slide: null, insertAfter: after, blocks: [], comment: '' });
      renderStrip();
      showSlide('sketch:' + item.id);
      toast('New slide sketch added. Drag on the canvas to place blocks.');
    } catch (err) { toast(`Could not add sketch: ${err.message}`, true); }
  });

  // ---------- panel ----------
  function numberedItems() {
    // Numbers are stable per slide: creation order of every item on that slide.
    const map = new Map();
    const bySlide = new Map();
    for (const f of state.feedback) {
      const key = f.slide || 'sketch:' + f.id;
      const n = (bySlide.get(key) || 0) + 1;
      bySlide.set(key, n);
      map.set(f.id, n);
    }
    return map;
  }
  function slideNumber(id) {
    const i = state.deck.slides.indexOf(id);
    return i < 0 ? null : i + 1;
  }

  const KIND = { comment: 'Comment', adjust: 'Move & resize', layout: 'Layout sketch' };

  function renderPanel() {
    if (!state.deck) return;
    const nums = numberedItems();
    const inScope = state.feedback.filter((f) => state.scope === 'all' || f.slide === state.current || 'sketch:' + f.id === state.current);
    $('#countOpen').textContent = inScope.filter((f) => f.status === 'open').length;
    $('#countDone').textContent = inScope.filter((f) => f.status !== 'open').length;
    const items = inScope.filter((f) => (state.status === 'open' ? f.status === 'open' : f.status !== 'open'));
    const list = $('#fbList');

    if (!items.length) {
      list.innerHTML = state.status === 'open'
        ? `<li class="fb-empty"><p>Nothing open ${state.scope === 'all' ? 'in this deck' : 'on this slide'}.</p><p class="sub">Press <kbd>C</kbd> and click anything on the slide to leave a comment, or <kbd>A</kbd> to drag things where they belong.</p></li>`
        : `<li class="fb-empty"><p>Nothing applied yet.</p><p class="sub">When Claude applies feedback it moves here with a note on what changed.</p></li>`;
      return;
    }

    list.replaceChildren(...items.map((f) => {
      const li = document.createElement('li');
      li.className = 'fb-item' + (f.id === state.activeItem ? ' active' : '');
      li.dataset.id = f.id;
      li.dataset.type = f.type;
      li.dataset.status = f.status;
      const where = f.slide ? `Slide ${slideNumber(f.slide) ?? '?'}` : 'New slide';
      const target = f.type === 'layout' ? `${f.blocks?.length || 0} block${f.blocks?.length === 1 ? '' : 's'}` : (f.target?.el || f.target?.selector || '');
      li.innerHTML = `
        <div class="fb-top"><span class="fb-num"></span><span class="fb-kind"></span><span class="fb-target"></span>${state.scope === 'all' ? '<span class="fb-slide"></span>' : ''}</div>
        <textarea rows="2"></textarea>
        ${f.type === 'adjust' && f.to ? `<p class="fb-meta">${fmtRect(f.target.rect)} → ${fmtRect(f.to)}</p>` : ''}
        ${f.type === 'layout' && f.blocks?.length ? `<p class="fb-meta">${f.blocks.map((b) => esc(b.label || 'unnamed')).join(' · ')}</p>` : ''}
        ${f.resolution ? `<p class="fb-resolution"><b>Claude:</b> </p>` : ''}
        <div class="fb-actions">
          ${f.status === 'open' ? '' : '<button class="icon-btn" data-act="reopen" title="Reopen"><svg><use href="#i-reopen"/></svg></button>'}
          <button class="icon-btn" data-act="delete" title="Delete"><svg><use href="#i-trash"/></svg></button>
        </div>`;
      $('.fb-num', li).textContent = nums.get(f.id);
      $('.fb-kind', li).textContent = KIND[f.type];
      $('.fb-target', li).textContent = target;
      if ($('.fb-slide', li)) $('.fb-slide', li).textContent = where;
      if (f.resolution) $('.fb-resolution', li).append(f.resolution);
      const ta = $('textarea', li);
      ta.value = f.comment || '';
      ta.placeholder = f.type === 'comment' ? 'Comment' : f.type === 'adjust' ? 'Optional: why it moves' : 'Optional: notes for this layout';
      ta.disabled = f.status !== 'open';
      ta.addEventListener('change', () => saveItem('PATCH', f.id, { comment: ta.value.trim() }).catch((e) => toast(e.message, true)));
      li.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'delete') return removeItem(f);
        if (act === 'reopen') return saveItem('PATCH', f.id, { status: 'open' }).then(afterFeedbackChange);
        if (e.target === ta) return;
        const slide = f.slide || 'sketch:' + f.id;
        if (slide !== state.current) showSlide(slide);
        focusItem(f.id, false);
      });
      return li;
    }));
  }

  async function removeItem(f) {
    try {
      await saveItem('DELETE', f.id);
      if (f.type === 'adjust') reloadFrame();
      if (!f.slide && state.current === 'sketch:' + f.id) state.current = f.insertAfter || state.deck.slides[0];
      renderStrip();
      showSlide(state.current);
      afterFeedbackChange();
    } catch (err) { toast(err.message, true); }
  }

  function focusItem(id, scroll = true) {
    state.activeItem = id;
    const f = state.feedback.find((x) => x.id === id);
    if (f && f.status !== state.status && !(state.status === 'done' && f.status !== 'open')) {
      state.status = f.status === 'open' ? 'open' : 'done';
      syncTabs();
    }
    renderPanel();
    drawOverlay();
    const li = $(`.fb-item[data-id="${id}"]`);
    if (scroll) li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function afterFeedbackChange() {
    renderPanel();
    updatePanelCount();
    drawOverlay();
    // Badges only; rebuilding thumbnails would reload every iframe.
    for (const li of $$('.thumb:not(.ghost)')) {
      const open = state.feedback.filter((f) => f.slide === li.dataset.id && f.status === 'open').length;
      let badge = $('.badge', li);
      if (!open) { badge?.remove(); continue; }
      if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; $('.frame', li).append(badge); }
      badge.textContent = open;
    }
    if (slideOrder().length !== $$('.thumb').length) renderStrip();
  }

  function syncTabs() {
    $$('[data-scope]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.scope === state.scope)));
    $$('[data-status]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.status === state.status)));
  }
  $$('[data-scope]').forEach((b) => b.addEventListener('click', () => { state.scope = b.dataset.scope; syncTabs(); renderPanel(); }));
  $$('[data-status]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; syncTabs(); renderPanel(); drawOverlay(); }));

  const fmtRect = (r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}×${Math.round(r.h)}`;
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input, textarea');
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      closePopover();
      state.selected = null; state.selBlock = null;
      return drawOverlay();
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const modeKey = { v: 'view', c: 'comment', a: 'adjust', b: 'block' }[k];
    if (modeKey) return setMode(modeKey);
    if (k === 'f') return setPanel(document.body.classList.contains('panel-off'));

    if (state.mode === 'adjust' && state.selected && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const r = { ...state.selected.rect };
      if (e.key === 'ArrowLeft') r.x -= step;
      if (e.key === 'ArrowRight') r.x += step;
      if (e.key === 'ArrowUp') r.y -= step;
      if (e.key === 'ArrowDown') r.y += step;
      applyRect(r);
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(commitAdjust, 350);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.mode === 'adjust' && state.selected) return revertAdjust();
      if (state.mode === 'block' && state.selBlock) return deleteBlock(state.selBlock);
    }
    const order = slideOrder();
    const i = order.indexOf(state.current);
    if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key) && i < order.length - 1) { e.preventDefault(); showSlide(order[i + 1]); }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key) && i > 0) { e.preventDefault(); showSlide(order[i - 1]); }
  });
  let nudgeTimer = null;

  // ---------- feedback panel toggle (remembered per browser) ----------
  function setPanel(show) {
    document.body.classList.toggle('panel-off', !show);
    $('#togglePanel').setAttribute('aria-pressed', String(show));
    try { localStorage.setItem('ps-panel', show ? 'on' : 'off'); } catch { /* storage unavailable */ }
    updatePanelCount();
  }
  function updatePanelCount() {
    const badge = $('#panelCount');
    const open = state.deck ? state.feedback.filter((f) => f.status === 'open').length : 0;
    badge.hidden = !document.body.classList.contains('panel-off') || !open;
    badge.textContent = open;
  }
  $('#togglePanel').addEventListener('click', () => setPanel(document.body.classList.contains('panel-off')));
  try { if (localStorage.getItem('ps-panel') === 'off') setPanel(false); } catch { /* storage unavailable */ }

  // ---------- top bar actions ----------
  $('#copyPrompt').addEventListener('click', async () => {
    const open = state.feedback.filter((f) => f.status === 'open').length;
    const text = `/apply-feedback ${state.deck.id}`;
    try { await navigator.clipboard.writeText(text); toast(`Copied "${text}" (${open} open item${open === 1 ? '' : 's'}). Paste it into Claude Code.`); }
    catch { toast(text); }
  });

  $('#exportPdf').addEventListener('click', async () => {
    const btn = $('#exportPdf');
    btn.disabled = true;
    $('span', btn).textContent = 'Exporting…';
    try {
      const r = await api('POST', `/api/decks/${state.deck.id}/export`);
      toast(`PDF ready, ${r.slides} slides.`, false, { href: r.url, text: 'Open PDF' });
    } catch (err) {
      toast(`Export failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      $('span', btn).textContent = 'Export PDF';
    }
  });

  let toastTimer = null;
  function toast(msg, error = false, link = null) {
    const t = $('#toast');
    t.replaceChildren(msg);
    if (link) {
      const a = document.createElement('a');
      a.href = link.href; a.target = '_blank'; a.textContent = link.text;
      t.append(a);
    }
    t.classList.toggle('error', error);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, link ? 8000 : 3500);
  }

  // ---------- live reload ----------
  function connect() {
    const live = $('#live');
    const es = new EventSource('/events');
    es.onopen = () => { live.dataset.state = 'on'; $('span', live).textContent = 'Live'; };
    es.onerror = () => { live.dataset.state = 'off'; $('span', live).textContent = 'Offline'; };
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.type === 'change') onChange(ev).catch((e) => console.error(e));
    };
  }

  let feedbackTimer = null;
  async function onChange({ scope, path }) {
    if (scope === 'studio') return location.reload();
    if (scope === 'profile') { reloadFrame(); return state.deck.slides.forEach(refreshThumb); }
    const [deck, ...rest] = path.split('/');
    if (!state.deck || deck !== state.deck.id) return;
    const file = rest.join('/');
    if (file === 'deck.json') return loadDeck(deck);
    if (file === 'deck.css' || file.startsWith('assets/')) { reloadFrame(); return state.deck.slides.forEach(refreshThumb); }
    const m = file.match(/^slides\/(.+)\.html$/);
    if (m) {
      refreshThumb(m[1]);
      if (m[1] === state.current) { state.selected = null; reloadFrame(); }
      return;
    }
    if (file === 'feedback.json') {
      // Our own writes echo back; only external edits (Claude) need a refetch.
      if (Date.now() - lastLocalWrite < 800) return;
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(async () => {
        if (document.activeElement?.matches('textarea, input')) return;
        state.feedback = await api('GET', fbUrl());
        renderStrip();
        if (!slideOrder().includes(state.current)) showSlide(state.deck.slides[0]);
        else { reloadFrame(); renderPanel(); }
      }, 150);
    }
  }

  // ---------- boot ----------
  (async () => {
    $('#hint').textContent = HINTS.view;
    try {
      const decks = await api('GET', '/api/decks');
      const want = new URLSearchParams(location.search).get('deck');
      const deck = decks.find((d) => d.id === want) || decks[0];
      if (!deck) {
        $('#deckTitle').textContent = 'No decks yet';
        $('#fbList').innerHTML = '<li class="fb-empty"><p>No decks in <code>decks/</code>.</p><p class="sub">Ask Claude Code to create one, following CLAUDE.md.</p></li>';
        return;
      }
      await loadDeck(deck.id);
      fit();
      connect();
    } catch (err) {
      toast(`Could not load the deck: ${err.message}`, true);
    }
  })();
})();
