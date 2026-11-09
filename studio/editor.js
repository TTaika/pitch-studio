// Pitch Studio video editor. The edit (videos/<id>/edit.json) is plain data the
// owner cuts here and Claude edits too; the preview is /render-edit/<id>, the same
// page HyperFrames renders, in a same-origin iframe driven by studio/edit-runtime.js.
// Comments and block sketches go to videos/<id>/feedback.json with the moment they
// are about, exactly like the deck studio.
(() => {
  const W = 1920, H = 1080;
  const PAD = 12;                        // timeline left padding, px
  const ROW = { overlay: 30, main: 64, audio: 30 };
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    list: [],            // [{id,title,duration}]
    project: null,       // GET /api/videos/:id  { id, rev, edit, media, scenes, model, render }
    feedback: [],
    decks: [],           // [{id,title,slides}]
    deckMeta: {},        // id → deck.json (slide ids), for the inspector
    mode: 'view',
    tab: 'clip',
    status: 'open',
    t: 0,
    playing: false,
    pe: null,            // window.__pe of the live preview frame
    frame: null,
    scale: 1,
    pps: 40,             // timeline px per second
    fitZoom: true,
    sel: null,           // { lane: 'main'|'overlays'|'audio', id }
    hover: null,
    popover: null,
    range: null,         // { from, to } dragged on the ruler (comment mode)
    selBlock: null,
    activeItem: null,
    uploads: new Map(),  // key → { name, pct }
    undo: [],
    redo: [],
  };

  const canvas = $('#canvas');
  const overlay = $('#overlay');
  const tlScroll = $('#tlScroll');
  const tlBody = $('#tlBody');

  const HINTS = {
    view: 'Space plays. Drag clips to reorder, drag their edges to trim, S splits at the playhead, Ctrl+Z undoes. Drag footage from the left onto the timeline.',
    comment: 'Pause on a moment and click anything (footage, slide text, an overlay) to comment on it. Drag along the ruler to comment on a stretch of time.',
    adjust: 'Drag an overlay to move it, drag a handle to resize. Arrow keys nudge (Shift = 10px). Changes save straight into the edit.',
    block: 'Drag on the frame to sketch what should appear at this moment ("logo", "price callout"). Claude builds it as overlays.',
  };

  // ---------- api ----------
  const api = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
    return data;
  };
  const vid = () => state.project?.id;
  const fbUrl = (id = '') => `/api/videos/${vid()}/feedback${id ? '/' + id : ''}`;

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
  const r1 = (n) => Math.round(n * 10) / 10;
  const r2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function fmt(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
  }
  const fmtShort = (t) => `${r1(t).toFixed(1)}s`;
  const fmtBin = (t) => `${Math.floor((t || 0) / 60)}:${String(Math.round((t || 0) % 60)).padStart(2, '0')}`;
  const model = () => state.project?.model;
  const duration = () => model()?.duration || 0;
  const x = (t) => PAD + t * state.pps;
  const tAt = (clientX) => {
    const r = tlBody.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - PAD) / state.pps);
  };
  const thumbUrl = (name) => `/videos/${vid()}/media/.thumbs/${encodeURIComponent(name.replace(/\.[^.]+$/, '.jpg'))}`;
  const LANES = { main: 'main', overlays: 'overlays', audio: 'audio' };
  function newId(prefix) {
    const e = state.project.edit;
    const used = new Set([...e.main, ...e.overlays, ...e.audio].map((c) => c.id));
    let id;
    do { id = `${prefix}-${Math.random().toString(16).slice(2, 6)}`; } while (used.has(id));
    return id;
  }
  const itemIn = (edit, lane, id) => edit[lane].find((c) => c.id === id);
  const resolvedOf = (lane, id) => model()?.[lane].find((c) => c.id === id);
  const selected = () => (state.sel ? resolvedOf(state.sel.lane, state.sel.id) : null);
  const hasWarning = (id) => model()?.warnings.some((w) => w.startsWith(id + ':'));
  const mediaInfo = (name) => state.project?.media[name] || null;

  // ---------- saving the edit (with undo) ----------
  let saving = Promise.resolve();
  function saveEdit(mutate, { undoable = true } = {}) {
    saving = saving.then(async () => {
      const before = state.project.edit;
      const edit = structuredClone(before);
      mutate(edit);
      lastLocalWrite = Date.now();
      try {
        const data = await api('PUT', `/api/videos/${vid()}`, { edit, rev: state.project.rev });
        if (undoable) { state.undo.push(before); if (state.undo.length > 100) state.undo.shift(); state.redo = []; }
        setProject(data);
        loadPreview();
      } catch (err) {
        if (err.status === 409) {
          setProject(err.data);
          loadPreview();
          toast('Claude changed this edit meanwhile. Loaded the new version; redo your last change.', true);
        } else toast(`Not saved: ${err.message}`, true);
      }
    });
    return saving;
  }
  function undo(redo = false) {
    const from = redo ? state.redo : state.undo;
    const to = redo ? state.undo : state.redo;
    const edit = from.pop();
    if (!edit) return toast(redo ? 'Nothing to redo.' : 'Nothing to undo.');
    to.push(state.project.edit);
    saveEdit((e) => { for (const k of Object.keys(e)) delete e[k]; Object.assign(e, structuredClone(edit)); }, { undoable: false });
  }

  function setProject(data) {
    state.project = data;
    if (state.sel && !resolvedOf(state.sel.lane, state.sel.id)) state.sel = null;
    $('#emptyStage').hidden = true;
    renderBin();
    renderTimeline();
    renderInspector();
    renderWarnings();
    updateTime();
  }

  async function refreshProject({ preview = false } = {}) {
    if (!vid()) return;
    const data = await api('GET', `/api/videos/${vid()}`);
    const changed = data.rev !== state.project.rev;
    setProject(data);
    if (preview || changed) loadPreview();
    return changed;
  }

  // ---------- projects ----------
  async function loadProject(id) {
    state.pe?.pause();
    state.undo = []; state.redo = [];
    state.sel = null; state.activeItem = null; state.range = null; state.popover = null;
    const [data, feedback] = await Promise.all([api('GET', `/api/videos/${id}`), api('GET', `/api/videos/${id}/feedback`)]);
    state.feedback = feedback;
    state.t = 0;
    state.fitZoom = true;
    setProject(data);
    history.replaceState(null, '', `/edit?v=${encodeURIComponent(id)}`);
    renderProjectSelect();
    loadPreview();
    renderPanel();
    if (data.render?.state === 'running') onRender({ ...data.render, video: id });
  }

  function renderProjectSelect() {
    const sel = $('#projectSelect');
    sel.replaceChildren(...state.list.map((p) => new Option(p.title || p.id, p.id)), new Option('New video…', '__new'));
    sel.value = vid() || '__new';
  }
  $('#projectSelect').addEventListener('change', (e) => {
    if (e.target.value === '__new') return showNewForm(true);
    loadProject(e.target.value).catch((err) => toast(err.message, true));
  });
  function showNewForm(show) {
    $('#newForm').hidden = !show;
    $('#projectSelect').hidden = show;
    if (show) $('#newName').focus();
    else $('#projectSelect').value = vid() || '__new';
  }
  $('#newCancel').addEventListener('click', () => showNewForm(false));
  $('#newForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#newName').value.trim();
    if (!title) return $('#newName').focus();
    try {
      const data = await api('POST', '/api/videos', { title });
      state.list = await api('GET', '/api/videos');
      $('#newName').value = '';
      showNewForm(false);
      await loadProject(data.id);
      toast('New video. Import footage on the left, or drop files anywhere.');
    } catch (err) { toast(err.message, true); }
  });

  // ---------- bin ----------
  function renderBin() {
    const p = state.project;
    const media = Object.entries(p?.media || {}).sort((a, b) => (a[1].importedAt || '').localeCompare(b[1].importedAt || ''));
    const list = $('#mediaList');
    const rows = media.map(([name, info]) => {
      const li = document.createElement('li');
      li.className = 'bin-item';
      li.dataset.status = info.status || 'ready';
      li.draggable = info.status === 'ready';
      const icon = info.kind === 'audio' ? 'i-music' : info.kind === 'image' ? 'i-image' : 'i-video';
      const meta = info.status === 'processing' ? 'Preparing preview…' : info.status === 'error' ? 'Import failed' :
        info.kind === 'image' ? 'image' : `${fmtBin(info.duration)}${info.height ? ` · ${info.height}p` : ''}${info.kind === 'video' && !info.hasAudio ? ' · mute' : ''}`;
      li.innerHTML = `<span class="th"><svg><use href="#${icon}"/></svg></span><span class="nm"><b></b><small></small></span>
        <button class="icon-btn add" title="${info.kind === 'audio' ? 'Add under the picture at the playhead' : 'Add to the end of the main track'}" aria-label="Add"><svg><use href="#i-plus"/></svg></button>`;
      $('b', li).textContent = name;
      $('small', li).textContent = meta;
      if (info.error) li.title = info.error;
      if (info.thumb) $('.th', li).style.backgroundImage = `url("${thumbUrl(name)}")`, $('.th', li).replaceChildren();
      if (info.kind === 'image') $('.th', li).style.backgroundImage = `url("/videos/${vid()}/media/${encodeURIComponent(name)}")`, $('.th', li).replaceChildren();
      $('.add', li).disabled = info.status !== 'ready';
      $('.add', li).addEventListener('click', () => addMedia(name));
      li.addEventListener('dragstart', (e) => dragPayload(e, { type: 'media', src: name, kind: info.kind }));
      li.addEventListener('dblclick', () => info.status === 'ready' && addMedia(name));
      return li;
    });
    for (const [, u] of state.uploads) {
      const li = document.createElement('li');
      li.className = 'bin-item';
      li.dataset.status = 'uploading';
      li.innerHTML = `<span class="th"><svg><use href="#i-import"/></svg></span><span class="nm"><b></b><small></small></span>`;
      $('b', li).textContent = u.name;
      $('small', li).textContent = `Uploading ${u.pct}%`;
      rows.push(li);
    }
    if (!rows.length) {
      list.innerHTML = '<li class="bin-empty">No footage yet. Import clips, or drop files anywhere on this window.</li>';
    } else list.replaceChildren(...rows);

    $('#deckList').replaceChildren(...(state.decks.length ? state.decks.map((d) => {
      const li = document.createElement('li');
      li.className = 'bin-item text-only';
      li.draggable = true;
      li.innerHTML = `<span class="th"><svg><use href="#i-deck"/></svg></span><span class="nm"><b></b><small></small></span>
        <button class="icon-btn add" title="Add the deck's slides as scenes at the end" aria-label="Add"><svg><use href="#i-plus"/></svg></button>`;
      $('b', li).textContent = d.title || d.id;
      $('small', li).textContent = `${d.slides} slides`;
      $('.add', li).addEventListener('click', () => addMain({ type: 'deck', deck: d.id }));
      li.addEventListener('dragstart', (e) => dragPayload(e, { type: 'deck', deck: d.id }));
      return li;
    }) : [Object.assign(document.createElement('li'), { className: 'bin-empty', textContent: 'No decks yet.' })]));

    const scenes = p?.scenes || [];
    const sl = $('#sceneList');
    if (!scenes.length) {
      sl.innerHTML = '<li class="bin-empty">None yet. Describe one to Claude ("an animation of the app\'s three steps"); it lands here.</li>';
    } else {
      sl.replaceChildren(...scenes.map((name) => {
        const li = document.createElement('li');
        li.className = 'bin-item text-only';
        li.draggable = true;
        li.innerHTML = `<span class="th"><svg><use href="#i-scene"/></svg></span><span class="nm"><b></b><small>scenes/${esc(name)}</small></span>
          <button class="icon-btn add" title="Add as a full-frame scene at the end" aria-label="Add"><svg><use href="#i-plus"/></svg></button>`;
        $('b', li).textContent = name;
        $('.add', li).addEventListener('click', () => addMain({ type: 'scene', scene: name, duration: 5 }));
        li.addEventListener('dragstart', (e) => dragPayload(e, { type: 'scene', scene: name }));
        return li;
      }));
    }
  }

  function dragPayload(e, payload) {
    e.dataTransfer.setData('application/x-ps-clip', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
  }

  function mainItemFor(payload) {
    if (payload.type === 'media') {
      const info = mediaInfo(payload.src);
      return info?.kind === 'image'
        ? { type: 'media', src: payload.src, duration: 4 }
        : { type: 'media', src: payload.src, in: 0, out: info?.duration || 5, volume: 1 };
    }
    if (payload.type === 'deck') return { type: 'deck', deck: payload.deck };
    if (payload.type === 'scene') return { type: 'scene', scene: payload.scene, duration: 5 };
    return null;
  }
  function addMain(item, index = null) {
    const id = newId('c');
    state.sel = { lane: 'main', id };
    return saveEdit((e) => e.main.splice(index ?? e.main.length, 0, { id, ...item }));
  }
  function addMedia(name, at = null) {
    const info = mediaInfo(name);
    if (!info || info.status !== 'ready') return;
    if (info.kind === 'audio') return addAudio(name, at ?? state.t);
    addMain(mainItemFor({ type: 'media', src: name }));
  }
  function addAudio(name, start) {
    const id = newId('a');
    state.sel = { lane: 'audio', id };
    return saveEdit((e) => e.audio.push({ id, src: name, start: r2(start), in: 0, volume: 0.8 }));
  }

  const OV_DEFAULTS = {
    title: { text: 'Title', sub: '', anim: 'rise', box: { x: 96, y: 96, w: 1100, h: 330 } },
    lower: { text: 'Name', sub: 'Role', anim: 'slide', box: { x: 96, y: 820, w: 760, h: 150 } },
    label: { text: 'Label', anim: 'fade', box: { x: 120, y: 120, w: 420, h: 80 } },
    arrow: { text: '', dir: 'left', anim: 'pop', box: { x: 1180, y: 380, w: 620, h: 120 } },
    highlight: { text: '', anim: 'pop', box: { x: 760, y: 340, w: 400, h: 400 } },
    image: { anim: 'fade', box: { x: 1520, y: 64, w: 320, h: 180 } },
    anim: { anim: 'fade', box: { x: 960, y: 120, w: 840, h: 600 } },
  };
  function addOverlay(kind, extra = {}, at = state.t) {
    const id = newId('o');
    const start = r2(Math.min(at, Math.max(0, duration() - 0.5)));
    state.sel = { lane: 'overlays', id };
    setTab('clip');
    return saveEdit((e) => e.overlays.push({ id, kind, ...structuredClone(OV_DEFAULTS[kind]), ...extra, start, duration: 3 }))
      .then(() => $('#inspector [data-k="text"]')?.select());
  }
  $$('.ov-add').forEach((b) => b.addEventListener('click', () => {
    if (!state.project?.edit.main.length) return toast('Put some footage on the main track first; overlays sit on top of it.');
    addOverlay(b.dataset.kind);
  }));

  // ---------- import ----------
  $('#importBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { [...e.target.files].forEach(upload); e.target.value = ''; });
  function upload(file) {
    if (!vid()) return toast('Create a video first.', true);
    const key = Math.random().toString(36).slice(2);
    state.uploads.set(key, { name: file.name, pct: 0 });
    renderBin();
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/videos/${vid()}/media?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      state.uploads.get(key).pct = Math.round((e.loaded / e.total) * 100);
      renderBin();
    };
    xhr.onloadend = () => {
      state.uploads.delete(key);
      if (xhr.status >= 300 || xhr.status === 0) {
        let msg = xhr.statusText || 'network error';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not json */ }
        toast(`${file.name}: ${msg}`, true);
      }
      refreshProject().catch(() => {});
    };
    xhr.send(file);
  }
  // Files dropped anywhere import; clips dragged from the bin go to the timeline instead.
  let dragDepth = 0;
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; $('#dropHint').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').hidden = true;
    [...e.dataTransfer.files].forEach(upload);
  });

  // ---------- preview ----------
  // Double-buffered: the next frame loads hidden and swaps in, so edits never flash black.
  let frameSeq = 0;
  function loadPreview() {
    if (!vid()) return;
    const seq = ++frameSeq;
    const f = document.createElement('iframe');
    f.className = 'loading';
    f.title = 'Video preview';
    f.tabIndex = -1;
    f.style.transform = `scale(${state.scale})`;
    f.src = `/render-edit/${encodeURIComponent(vid())}?v=${seq}`;
    f.addEventListener('load', async () => {
      if (seq !== frameSeq) return f.remove();
      const w = f.contentWindow;
      try { await w.document.fonts.ready; } catch { /* no fonts api */ }
      if (seq !== frameSeq) return f.remove();
      const pe = w.__pe;
      const wasPlaying = state.pe?.playing;
      state.pe?.pause();
      for (const old of $$('#frames iframe')) if (old !== f) old.remove();
      f.classList.remove('loading');
      state.frame = f;
      state.pe = pe || null;
      if (!pe) { toast('The preview did not start; check the browser console of the preview page.', true); return; }
      pe.onTick = onTick;
      pe.seek(Math.min(state.t, pe.duration));
      if (wasPlaying) pe.play();
      drawOverlay();
    });
    $('#frames').append(f);
  }
  const doc = () => state.frame?.contentDocument;

  function onTick(t, playing) {
    const wasPlaying = state.playing;
    state.t = t;
    state.playing = playing;
    updateTime();
    if (playing) {
      const px = x(t);
      if (px > tlScroll.scrollLeft + tlScroll.clientWidth - 60 || px < tlScroll.scrollLeft) tlScroll.scrollLeft = Math.max(0, px - 80);
      if (!wasPlaying) drawOverlay();
    } else drawOverlay();
  }
  function seek(t) {
    t = clamp(t, 0, duration());
    if (state.pe) state.pe.seek(t);
    else { state.t = t; updateTime(); }
  }
  function play() { if (state.pe && duration() > 0) { closePopover(); state.pe.play(); } }
  function pause() { state.pe?.pause(); }
  $('#playBtn').addEventListener('click', () => (state.playing ? pause() : play()));

  function updateTime() {
    $('#timeLabel').textContent = `${fmt(state.t)} / ${fmt(duration())}`;
    $('#playhead').style.left = x(state.t) + 'px';
    const btn = $('#playBtn');
    $('use', btn).setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    btn.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    $('#splitBtn').disabled = !splitTarget();
    $('#deleteBtn').disabled = !state.sel;
  }

  function renderWarnings() {
    const w = model()?.warnings || [];
    const el = $('#warnings');
    el.hidden = !w.length;
    el.textContent = !w.length ? '' : w.length === 1 ? w[0] : `${w.length} problems: ${w[0]}`;
    el.title = w.join('\n');
  }

  // ---------- fit ----------
  function fit() {
    const stage = $('#stage');
    const availW = stage.clientWidth - 36;
    const availH = stage.clientHeight - 28 - 36 - 12;
    state.scale = Math.max(0.05, Math.min(availW / W, availH / H));
    Object.assign(canvas.style, { width: W * state.scale + 'px', height: H * state.scale + 'px' });
    $('#transport').style.width = W * state.scale + 'px';
    for (const f of $$('#frames iframe')) f.style.transform = `scale(${state.scale})`;
    drawOverlay();
  }
  window.addEventListener('resize', () => { fit(); if (state.fitZoom) renderTimeline(); });

  // ---------- modes ----------
  function setMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;
    $$('.modes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('#hint').textContent = HINTS[mode];
    state.hover = null; state.selBlock = null;
    if (mode !== 'comment') { state.range = null; drawRange(); }
    closePopover();
    if (mode !== 'view') pause();
    drawOverlay();
  }
  $$('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // ---------- timeline ----------
  function fitPps() {
    const w = tlScroll.clientWidth - PAD * 2 - 60;
    return clamp(w / Math.max(duration(), 5), 4, 400);
  }
  function setZoom(pps, fitMode = false) {
    const center = state.t;
    state.fitZoom = fitMode;
    state.pps = clamp(pps, 4, 400);
    renderTimeline();
    if (!fitMode) tlScroll.scrollLeft = Math.max(0, x(center) - tlScroll.clientWidth / 2);
  }
  $('#zoomIn').addEventListener('click', () => setZoom(state.pps * 1.5));
  $('#zoomOut').addEventListener('click', () => setZoom(state.pps / 1.5));
  $('#zoomFit').addEventListener('click', () => setZoom(fitPps(), true));
  tlScroll.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  }, { passive: false });
  tlScroll.addEventListener('scroll', () => { $('#tlHeads').scrollTop = tlScroll.scrollTop; });

  // Overlays (and audio) pack into as few rows as possible without overlapping.
  function pack(items) {
    const rows = [];
    const at = new Map();
    for (const it of [...items].sort((a, b) => a.start - b.start)) {
      let r = rows.findIndex((end) => end <= it.start + 0.001);
      if (r < 0) { r = rows.length; rows.push(0); }
      rows[r] = it.start + it.duration;
      at.set(it.id, r);
    }
    return { rows: Math.max(1, rows.length), at };
  }

  function tickStep() {
    for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * state.pps >= 64) return s;
    return 300;
  }

  function renderTimeline() {
    const m = model();
    const lanes = $('#lanes');
    const heads = $('#tlHeads');
    if (!m) { lanes.replaceChildren(); heads.replaceChildren(); return; }
    if (state.fitZoom) state.pps = fitPps();
    const dur = m.duration;
    const width = Math.max(tlScroll.clientWidth, PAD * 2 + (dur + 8) * state.pps);
    tlBody.style.width = width + 'px';

    // ruler
    const ruler = $('#ruler');
    const step = tickStep();
    const minor = step / (step >= 10 ? 5 : step >= 2 ? 4 : 5);
    const ticks = [];
    const end = (width - PAD) / state.pps;
    for (let i = 0; i * minor <= end; i++) {
      const t = i * minor;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ticks.push(`<div class="tick${major ? ' major' : ''}" style="left:${x(t)}px">${major ? `<span>${step < 1 ? fmt(t).slice(1) : fmt(t).slice(0, 5)}</span>` : ''}</div>`);
    }
    ruler.innerHTML = ticks.join('') + '<div class="range-sel" id="rangeSel" hidden></div>';
    drawMarkers();
    drawRange();

    const ov = pack(m.overlays);
    const au = pack(m.audio);
    const laneEls = [];
    const headEls = [];
    const head = (label, icon, h) => {
      const d = document.createElement('div');
      d.className = 'tl-head';
      d.style.height = h + 'px';
      d.innerHTML = `<svg><use href="#${icon}"/></svg><span>${label}</span>`;
      return d;
    };

    const ovLane = laneEl('overlays', ov.rows * ROW.overlay);
    for (const o of m.overlays) ovLane.append(clipEl('overlays', o, ov.at.get(o.id)));
    if (!m.overlays.length && m.main.length) ovLane.append(Object.assign(document.createElement('span'), { className: 'lane-empty', textContent: 'Titles, labels and arrows from the left sit here, over the picture.' }));
    laneEls.push(ovLane); headEls.push(head('Overlays', 'i-text', ov.rows * ROW.overlay + 1));

    const mainLane = laneEl('main', ROW.main);
    mainLane.classList.add('main');
    for (const c of m.main) mainLane.append(clipEl('main', c, 0));
    if (!m.main.length) mainLane.append(Object.assign(document.createElement('span'), { className: 'lane-empty', textContent: 'Drag footage, a deck or an animation here. Clips play back to back.' }));
    laneEls.push(mainLane); headEls.push(head('Main', 'i-video', ROW.main + 1));

    const auLane = laneEl('audio', au.rows * ROW.audio);
    for (const a of m.audio) auLane.append(clipEl('audio', a, au.at.get(a.id)));
    if (!m.audio.length && m.main.length) auLane.append(Object.assign(document.createElement('span'), { className: 'lane-empty', textContent: 'Music or voiceover: import an audio file and drop it here.' }));
    laneEls.push(auLane); headEls.push(head('Audio', 'i-music', au.rows * ROW.audio + 1));

    lanes.replaceChildren(...laneEls);
    heads.replaceChildren(...headEls);
    updateTime();
  }

  function laneEl(lane, h) {
    const d = document.createElement('div');
    d.className = 'lane';
    d.dataset.lane = lane;
    d.style.height = h + 'px';
    d.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('application/x-ps-clip')) return;
      e.preventDefault();
      d.classList.add('drop-target');
      if (lane === 'main') showInsertMark(mainIndexAt(e.clientX));
    });
    d.addEventListener('dragleave', () => { d.classList.remove('drop-target'); hideInsertMark(); });
    d.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-ps-clip');
      d.classList.remove('drop-target');
      hideInsertMark();
      if (!raw) return;
      e.preventDefault();
      dropOnLane(lane, JSON.parse(raw), e.clientX);
    });
    return d;
  }

  function dropOnLane(lane, p, clientX) {
    const t = r2(tAt(clientX));
    if (lane === 'main') {
      if (p.kind === 'audio') return toast('Audio goes on the Audio lane, under the picture.');
      return addMain(mainItemFor(p), mainIndexAt(clientX));
    }
    if (lane === 'audio') {
      if (p.kind !== 'audio') return toast('Only audio files go on the Audio lane.');
      return addAudio(p.src, t);
    }
    if (lane === 'overlays') {
      if (p.type === 'media' && p.kind === 'image') return addOverlay('image', { src: p.src }, t);
      if (p.type === 'scene') return addOverlay('anim', { scene: p.scene }, t);
      return toast('Over the picture: images and animations. Footage goes on the Main lane.');
    }
  }

  function clipEl(lane, c, row) {
    const el = document.createElement('div');
    el.className = 'clip';
    el.dataset.lane = lane;
    el.dataset.id = c.id;
    el.style.left = x(c.start) + 'px';
    el.style.width = Math.max(4, c.duration * state.pps) + 'px';
    if (lane !== 'main') {
      const h = ROW[lane === 'overlays' ? 'overlay' : 'audio'];
      Object.assign(el.style, { top: row * h + 3 + 'px', height: h - 6 + 'px', bottom: 'auto' });
    }
    if (state.sel?.lane === lane && state.sel.id === c.id) el.classList.add('sel');
    if (hasWarning(c.id)) el.classList.add('missing');
    let label = '', sub = fmtShort(c.duration), edges = true;
    if (lane === 'main' && c.type === 'media') {
      label = c.src;
      if (mediaInfo(c.src)?.thumb) {
        const film = document.createElement('div');
        film.className = 'film';
        film.style.backgroundImage = `url("${thumbUrl(c.src)}")`;
        el.append(film);
      }
    } else if (c.type === 'deck') {
      el.classList.add('deck');
      label = `Deck · ${c.deck}`;
      edges = false;
      (c.slides || []).forEach((s, i) => {
        const left = (s.start - c.start) * state.pps;
        if (i) el.append(Object.assign(document.createElement('div'), { className: 'cut', style: `left:${left}px` }));
        const n = document.createElement('div');
        n.className = 'slide-name';
        Object.assign(n.style, { left: left + 6 + 'px', maxWidth: s.duration * state.pps - 10 + 'px' });
        n.textContent = s.id;
        el.append(n);
      });
    } else if (c.type === 'scene') {
      el.classList.add('scene');
      label = `Animation · ${c.scene}`;
    } else if (lane === 'overlays') {
      el.classList.add('overlay-c');
      label = c.kind === 'image' ? c.src : c.kind === 'anim' ? `Animation · ${c.scene}` : c.text || c.kind;
      sub = c.kind;
    } else if (lane === 'audio') {
      el.classList.add('audio-c');
      label = c.src;
    }
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.innerHTML = '<b></b><small></small>';
    $('b', lbl).textContent = label;
    $('small', lbl).textContent = sub;
    el.append(lbl);
    el.title = `${label} (${fmt(c.start)} – ${fmt(c.start + c.duration)})${hasWarning(c.id) ? '\n' + model().warnings.filter((w) => w.startsWith(c.id + ':')).join('\n') : ''}`;
    if (edges) el.append(Object.assign(document.createElement('div'), { className: 'edge l' }), Object.assign(document.createElement('div'), { className: 'edge r' }));
    return el;
  }

  function mainIndexAt(clientX) {
    const t = tAt(clientX);
    const main = model().main;
    let i = 0;
    while (i < main.length && t > main[i].start + main[i].duration / 2) i++;
    return i;
  }
  function showInsertMark(i) {
    const main = model().main;
    const t = i < main.length ? main[i].start : duration();
    let mark = $('.insert-mark');
    if (!mark) { mark = document.createElement('div'); mark.className = 'insert-mark'; $('.lane.main')?.append(mark); }
    mark.style.left = x(t) + 'px';
  }
  function hideInsertMark() { $('.insert-mark')?.remove(); }

  function select(lane, id) {
    state.sel = lane ? { lane, id } : null;
    $$('.clip.sel').forEach((c) => c.classList.remove('sel'));
    if (lane) $(`.clip[data-lane="${lane}"][data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
    if (lane) setTab('clip');
    renderInspector();
    updateTime();
    drawOverlay();
  }

  // Snap points: playhead, cuts, overlay edges; within 8px.
  function snap(t, selfId) {
    const m = model();
    const pts = [0, state.t, m.duration];
    for (const c of m.main) pts.push(c.start, c.start + c.duration);
    for (const o of [...m.overlays, ...m.audio]) if (o.id !== selfId) pts.push(o.start, o.start + o.duration);
    const tol = 8 / state.pps;
    let best = t, d = tol;
    for (const p of pts) if (Math.abs(p - t) < d) { d = Math.abs(p - t); best = p; }
    return best;
  }

  let tlDrag = null;
  tlBody.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.marker')) return;
    const clip = e.target.closest('.clip');
    if (clip && state.mode !== 'comment') return startClipDrag(e, clip);
    // Ruler or empty lane: scrub. In comment mode a drag selects a stretch of time.
    pause();
    closePopover();
    const t0 = tAt(e.clientX);
    tlDrag = { kind: 'scrub', t0, moved: false };
    tlBody.setPointerCapture(e.pointerId);
    if (state.mode === 'comment' && e.target.closest('#ruler')) { tlDrag.kind = 'range'; state.range = null; drawRange(); }
    else { seek(t0); if (!clip) select(null); }
  });
  tlBody.addEventListener('pointermove', (e) => {
    if (!tlDrag) return;
    if (tlDrag.kind === 'scrub') return seek(tAt(e.clientX));
    if (tlDrag.kind === 'range') {
      const t = clamp(tAt(e.clientX), 0, duration());
      if (Math.abs(t - tlDrag.t0) * state.pps > 4) tlDrag.moved = true;
      state.range = { from: Math.min(t, tlDrag.t0), to: Math.max(t, tlDrag.t0) };
      drawRange();
      return;
    }
    moveClipDrag(e);
  });
  tlBody.addEventListener('pointerup', (e) => {
    if (!tlDrag) return;
    const d = tlDrag;
    tlDrag = null;
    if (d.kind === 'scrub') return;
    if (d.kind === 'range') {
      if (!d.moved) { state.range = null; drawRange(); return seek(d.t0); }
      seek(state.range.from);
      return openRangePopover();
    }
    endClipDrag(e, d);
  });

  function startClipDrag(e, el) {
    const lane = el.dataset.lane, id = el.dataset.id;
    const c = resolvedOf(lane, id);
    if (!c) return;
    select(lane, id);
    const edge = e.target.closest('.edge');
    tlDrag = {
      kind: edge ? (edge.classList.contains('l') ? 'trim-l' : 'trim-r') : 'move',
      lane, id, el, c, x0: e.clientX, moved: false,
      left: parseFloat(el.style.left), width: parseFloat(el.style.width),
    };
    tlBody.setPointerCapture(e.pointerId);
  }

  // Works out the new values for a drag; used live (visuals) and on drop (save).
  function dragResult(d, clientX) {
    const ds = (clientX - d.x0) / state.pps;
    const c = d.c;
    const info = c.src ? mediaInfo(c.src) : null;
    const full = info?.duration ?? Infinity;
    if (d.lane === 'main') {
      if (d.kind === 'move') return { index: mainIndexAt(clientX), dx: clientX - d.x0 };
      if (c.type === 'media' && c.kind !== 'image') {
        if (d.kind === 'trim-l') {
          const nin = clamp(c.in + ds, 0, c.out - 0.2);
          return { in: r2(nin), left: x(c.start + (nin - c.in)), width: (c.out - nin) * state.pps };
        }
        const nout = clamp(c.out + ds, c.in + 0.2, full);
        return { out: r2(nout), left: x(c.start), width: (nout - c.in) * state.pps };
      }
      const nd = Math.max(0.5, c.duration + (d.kind === 'trim-l' ? -ds : ds));
      return { duration: r2(nd), left: d.kind === 'trim-l' ? x(c.start + c.duration - nd) : x(c.start), width: nd * state.pps };
    }
    if (d.lane === 'overlays') {
      if (d.kind === 'move') {
        let s = Math.max(0, c.start + ds);
        const snS = snap(s, c.id), snE = snap(s + c.duration, c.id) - c.duration;
        s = Math.abs(snS - s) <= Math.abs(snE - s) ? snS : snE;
        return { start: r2(Math.max(0, s)), left: x(Math.max(0, s)), width: d.width };
      }
      if (d.kind === 'trim-l') {
        const endT = c.start + c.duration;
        const s = clamp(snap(c.start + ds, c.id), 0, endT - 0.3);
        return { start: r2(s), duration: r2(endT - s), left: x(s), width: (endT - s) * state.pps };
      }
      const e2 = Math.max(c.start + 0.3, snap(c.start + c.duration + ds, c.id));
      return { duration: r2(e2 - c.start), left: x(c.start), width: (e2 - c.start) * state.pps };
    }
    // audio
    if (d.kind === 'move') {
      const s = Math.max(0, snap(c.start + ds, c.id));
      return { start: r2(s), left: x(s), width: d.width };
    }
    if (d.kind === 'trim-l') {
      const shift = clamp(ds, -c.in, c.duration - 0.3);
      return { start: r2(Math.max(0, c.start + shift)), in: r2(c.in + shift), left: x(c.start + shift), width: (c.duration - shift) * state.pps };
    }
    const nout = clamp(c.out + ds, c.in + 0.3, full);
    return { out: r2(nout), left: x(c.start), width: (nout - c.in) * state.pps };
  }

  function moveClipDrag(e) {
    const d = tlDrag;
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (!d.moved) return;
    d.el.classList.add('dragging');
    const r = dragResult(d, e.clientX);
    if (d.lane === 'main' && d.kind === 'move') {
      d.el.style.transform = `translateX(${r.dx}px)`;
      showInsertMark(r.index);
      return;
    }
    d.el.style.left = r.left + 'px';
    d.el.style.width = Math.max(4, r.width) + 'px';
    const shown = r.start ?? d.c.start;
    $('#coords').textContent = `${fmt(shown)} → ${fmt(shown + (r.duration ?? (r.width / state.pps)))}`;
  }

  function endClipDrag(e, d) {
    hideInsertMark();
    d.el.classList.remove('dragging');
    d.el.style.transform = '';
    $('#coords').textContent = '';
    if (!d.moved) return;
    const r = dragResult(d, e.clientX);
    if (d.lane === 'main' && d.kind === 'move') {
      const from = model().main.findIndex((c) => c.id === d.id);
      let to = r.index;
      if (to > from) to--;
      if (to === from) return renderTimeline();
      return saveEdit((edit) => { const [it] = edit.main.splice(from, 1); edit.main.splice(to, 0, it); });
    }
    const keys = ['start', 'duration', 'in', 'out'].filter((k) => r[k] !== undefined);
    saveEdit((edit) => { const it = itemIn(edit, d.lane, d.id); for (const k of keys) it[k] = r[k]; });
  }

  // ---------- split / delete ----------
  function splitTarget() {
    if (!model()) return null;
    const t = state.t;
    const inside = (c) => t > c.start + 0.1 && t < c.start + c.duration - 0.1;
    const sel = selected();
    if (sel && state.sel.lane !== 'main' && inside(sel)) return { lane: state.sel.lane, c: sel };
    const c = model().main.find(inside);
    return c && c.type !== 'deck' ? { lane: 'main', c } : null;
  }
  function split() {
    const target = splitTarget();
    if (!target) {
      const deck = model()?.main.find((c) => c.type === 'deck' && state.t > c.start && state.t < c.start + c.duration);
      return toast(deck ? 'Deck clips split by slide: untick slides in the Clip panel, or add the deck twice.' : 'Put the playhead inside a clip to split it.');
    }
    const { lane, c } = target;
    const t = state.t;
    const id2 = newId(lane === 'main' ? 'c' : lane === 'overlays' ? 'o' : 'a');
    saveEdit((edit) => {
      const it = itemIn(edit, lane, c.id);
      const second = structuredClone(it);
      second.id = id2;
      const local = t - c.start;
      if (lane === 'main' && c.type === 'media' && c.kind !== 'image') { it.out = r2(c.in + local); second.in = r2(c.in + local); }
      else if (lane === 'main') { it.duration = r2(local); second.duration = r2(c.duration - local); }
      else if (lane === 'overlays') { it.duration = r2(local); second.start = r2(t); second.duration = r2(c.duration - local); }
      else { it.out = r2(c.in + local); second.in = r2(c.in + local); second.start = r2(t); }
      const arr = edit[lane];
      arr.splice(arr.indexOf(it) + 1, 0, second);
    });
    state.sel = { lane, id: id2 };
  }
  function removeSelected() {
    if (!state.sel) return;
    const { lane, id } = state.sel;
    state.sel = null;
    saveEdit((edit) => { edit[lane] = edit[lane].filter((c) => c.id !== id); });
  }
  $('#splitBtn').addEventListener('click', split);
  $('#deleteBtn').addEventListener('click', removeSelected);

  // ---------- inspector ----------
  function setTab(tab) {
    state.tab = tab;
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('#inspector').hidden = tab !== 'clip';
    $('#fbList').hidden = tab !== 'feedback';
    $('#statusTabs').hidden = tab !== 'feedback';
  }
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  const field = (label, k, value, attrs = '') => `<label>${label}<input data-k="${k}" value="${esc(value ?? '')}" ${attrs}></label>`;
  const num = (label, k, value, step = 0.1, attrs = '') => field(label, k, value, `type="number" step="${step}" ${attrs}`);
  const ANIM_NAMES = { rise: 'Rise', slide: 'Slide in', fade: 'Fade', pop: 'Pop', wipe: 'Wipe', none: 'None' };

  async function deckSlides(deck) {
    if (!state.deckMeta[deck]) state.deckMeta[deck] = await api('GET', `/api/decks/${deck}`).catch(() => ({ slides: [] }));
    return state.deckMeta[deck].slides || [];
  }

  function renderInspector() {
    const box = $('#inspector');
    // Saving re-renders the form; keep focus on the field the owner tabbed into.
    const focusK = box.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const c = selected();
    if (!state.project) { box.innerHTML = ''; return; }
    if (!c) {
      box.innerHTML = `<div class="insp-empty"><p>Select a clip to edit it.</p>
        <p class="sub">Trim by dragging clip edges, reorder by dragging clips. <kbd>S</kbd> splits at the playhead, <kbd>Delete</kbd> removes, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes.</p>
        <p class="sub">For anything you can't do here (an animation of your product, a better cut, a punchier title), press <kbd>C</kbd>, click the moment and say it. Then copy the prompt for Claude.</p></div>`;
      return;
    }
    const lane = state.sel.lane;
    const raw = itemIn(state.project.edit, lane, c.id) || {};
    let html = '';
    const span = `<p class="sub">${fmt(c.start)} – ${fmt(c.start + c.duration)} · ${fmtShort(c.duration)}</p>`;
    if (lane === 'main' && c.type === 'media') {
      const info = mediaInfo(c.src);
      html = `<h3><svg><use href="#i-video"/></svg><span></span></h3>${span}`;
      if (c.kind === 'image') html += num('Duration (s)', 'duration', raw.duration ?? 4, 0.1, 'min="0.5"');
      else {
        html += `<div class="row">${num('From (s in clip)', 'in', r2(c.in), 0.1, 'min="0"')}${num('To (s in clip)', 'out', r2(c.out), 0.1, `min="0" max="${info?.duration ?? ''}"`)}</div>`;
        html += info?.hasAudio === false ? '<p class="note">This clip has no sound.</p>'
          : `<label>Volume<input type="range" data-k="volume" min="0" max="1" step="0.05" value="${raw.volume ?? 1}"></label>`;
        html += `<p class="note">Source is ${fmt(info?.duration)} long${info?.width ? `, ${info.width}×${info.height}` : ''}.</p>`;
      }
    } else if (c.type === 'deck') {
      html = `<h3><svg><use href="#i-deck"/></svg><span></span></h3>${span}
        <fieldset><legend>Slides in this clip</legend><div class="slides" id="slideChecks"><span class="note">Loading…</span></div></fieldset>
        <p class="note">Slides play with the deck's own motion. Change a slide in the <a href="/?deck=${encodeURIComponent(c.deck)}">deck studio</a>; it updates here.</p>`;
    } else if (c.type === 'scene') {
      html = `<h3><svg><use href="#i-scene"/></svg><span></span></h3>${span}
        <label>Animation<select data-k="scene">${(state.project.scenes.includes(c.scene) ? state.project.scenes : [c.scene, ...state.project.scenes]).map((s) => `<option${s === c.scene ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        ${num('Duration (s)', 'duration', raw.duration ?? 5, 0.1, 'min="0.5"')}
        <p class="note">Claude writes animations in <code>videos/${esc(vid())}/scenes/</code>. To change how it moves, comment on it.</p>`;
    } else if (lane === 'overlays') {
      const kinds = ['title', 'lower', 'label', 'arrow', 'highlight', 'image', 'anim'];
      html = `<h3><svg><use href="#i-text"/></svg><span></span></h3>${span}
        <label>Kind<select data-k="kind">${kinds.map((k) => `<option value="${k}"${k === c.kind ? ' selected' : ''}>${{ title: 'Title', lower: 'Lower third', label: 'Label', arrow: 'Arrow', highlight: 'Highlight', image: 'Image', anim: 'Animation' }[k]}</option>`).join('')}</select></label>`;
      if (['title', 'lower', 'label', 'arrow', 'highlight'].includes(c.kind)) {
        html += c.kind === 'title' ? `<label>Text<textarea data-k="text" rows="2">${esc(raw.text)}</textarea></label>` : field('Text', 'text', raw.text);
        if (c.kind === 'title' || c.kind === 'lower') html += field(c.kind === 'lower' ? 'Second line' : 'Subtitle', 'sub', raw.sub);
      }
      if (c.kind === 'arrow') html += `<label>Points<select data-k="dir">${['left', 'right', 'up', 'down', 'up-right'].map((d) => `<option${d === (raw.dir || 'right') ? ' selected' : ''}>${d}</option>`).join('')}</select></label>`;
      if (c.kind === 'image') html += `<label>Image<select data-k="src">${Object.entries(state.project.media).filter(([, i]) => i.kind === 'image').map(([n]) => `<option${n === raw.src ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>`;
      if (c.kind === 'anim') html += `<label>Animation<select data-k="scene">${state.project.scenes.map((s) => `<option${s === raw.scene ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>`;
      html += `<label>Entrance<select data-k="anim">${Object.entries(ANIM_NAMES).map(([k, v]) => `<option value="${k}"${k === c.anim ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <div class="row">${num('Starts at (s)', 'start', r2(c.start), 0.1, 'min="0"')}${num('Duration (s)', 'duration', r2(c.duration), 0.1, 'min="0.3"')}</div>
        <fieldset><legend>Box on the 1920×1080 frame (drag it in Adjust, <kbd>A</kbd>)</legend><div class="row4">
          ${num('X', 'box.x', c.box.x, 1)}${num('Y', 'box.y', c.box.y, 1)}${num('W', 'box.w', c.box.w, 1, 'min="10"')}${num('H', 'box.h', c.box.h, 1, 'min="10"')}</div></fieldset>`;
    } else if (lane === 'audio') {
      html = `<h3><svg><use href="#i-music"/></svg><span></span></h3>${span}
        ${num('Starts at (s)', 'start', r2(c.start), 0.1, 'min="0"')}
        <div class="row">${num('From (s in file)', 'in', r2(c.in), 0.1, 'min="0"')}${num('To (s in file)', 'out', r2(c.out), 0.1, 'min="0"')}</div>
        <label>Volume<input type="range" data-k="volume" min="0" max="1" step="0.05" value="${raw.volume ?? 1}"></label>
        <p class="note">Audio stops at the end of the picture.</p>`;
    }
    html += `<div class="acts"><button class="btn" data-act="split"><svg><use href="#i-split"/></svg>Split at playhead</button><button class="btn" data-act="remove"><svg><use href="#i-trash"/></svg>Remove</button></div>`;
    box.innerHTML = `<div class="insp">${html}</div>`;
    const title = lane === 'main' && c.type === 'media' ? c.src : c.type === 'deck' ? `Deck · ${c.deck}` : c.type === 'scene' ? `Animation · ${c.scene}` : lane === 'audio' ? c.src : 'Overlay';
    $('h3 span', box).textContent = title;
    $('[data-act="split"]', box).addEventListener('click', split);
    $('[data-act="remove"]', box).addEventListener('click', removeSelected);
    if (c.type === 'deck') fillSlideChecks(c, raw);

    for (const input of $$('[data-k]', box)) {
      input.addEventListener('change', () => {
        const k = input.dataset.k;
        let v = input.type === 'number' || input.type === 'range' ? Number(input.value) : input.value;
        if (input.type === 'number' && !isFinite(v)) return renderInspector();
        if (typeof v === 'string' && k !== 'text' && k !== 'sub') v = v.trim();
        const { lane: l, id } = state.sel;
        saveEdit((edit) => {
          const it = itemIn(edit, l, id);
          if (k.startsWith('box.')) { it.box = { ...(it.box || resolvedOf(l, id).box) }; it.box[k.slice(4)] = Math.round(v); }
          else if (k === 'kind') {
            // New kind, new default shape; the words carry over.
            const keep = { text: it.text, sub: it.sub };
            Object.assign(it, structuredClone(OV_DEFAULTS[v]), { kind: v });
            if (keep.text) it.text = keep.text;
            if (keep.sub) it.sub = keep.sub;
            if (v === 'image' && !it.src) it.src = Object.keys(state.project.media).find((n) => state.project.media[n].kind === 'image');
            if (v === 'anim' && !it.scene) it.scene = state.project.scenes[0];
          }
          else it[k] = v;
        });
      });
      if (input.tagName === 'INPUT' && input.type !== 'range') input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    }
    if (focusK) $(`[data-k="${focusK}"]`, box)?.focus();
  }

  async function fillSlideChecks(c, raw) {
    const all = await deckSlides(c.deck);
    const box = $('#slideChecks');
    if (!box || selected()?.id !== c.id) return;
    const on = new Set(raw.slides?.length ? raw.slides : all);
    box.replaceChildren(...all.map((s) => {
      const l = document.createElement('label');
      l.className = 'check';
      l.innerHTML = `<input type="checkbox"${on.has(s) ? ' checked' : ''}><span></span>`;
      $('span', l).textContent = s;
      $('input', l).addEventListener('change', () => {
        const picked = $$('input', box).map((i, j) => (i.checked ? all[j] : null)).filter(Boolean);
        if (!picked.length) { toast('A deck clip needs at least one slide. Remove the clip instead.'); return renderInspector(); }
        const id = c.id;
        saveEdit((edit) => { itemIn(edit, 'main', id).slides = picked.length === all.length ? undefined : picked; });
      });
      return l;
    }));
  }

  // ---------- canvas: comment / adjust / block ----------
  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
  }
  function place(el, r) {
    const s = state.scale;
    Object.assign(el.style, { left: r.x * s + 'px', top: r.y * s + 'px', width: r.w * s + 'px', height: r.h * s + 'px' });
  }
  const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
  function elRect(el) { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }

  // What the pointer is on, in edit terms: which clip, which element in it.
  function hitTest(p) {
    const d = doc();
    if (!d) return null;
    const el = d.elementFromPoint(p.x, p.y);
    if (!el || el === d.body || el === d.documentElement || el.id === 'root') return null;
    const host = el.closest('#root > .clip');
    if (!host) return null;
    const target = host.classList.contains('main-media') ? host : (el.closest('[data-el]') || el);
    return { el: target, host };
  }
  function describe(hit) {
    const { el, host } = hit;
    const m = model();
    let clip = host.id, slide = null, what;
    if (host.classList.contains('slide-clip')) {
      const deckClip = m.main.find((c) => c.type === 'deck' && host.id.startsWith(c.id + '-'));
      if (deckClip) { clip = deckClip.id; slide = host.id.slice(deckClip.id.length + 1); }
    }
    const resolved = resolvedOf('main', clip) || resolvedOf('overlays', clip);
    if (el === host && host.classList.contains('main-media')) what = `footage · ${resolved?.src || clip}`;
    else if (el.dataset.el) what = el.dataset.el;
    else what = `<${el.tagName.toLowerCase()}>`;
    const inner = el === host ? `#${host.id}` : el.dataset.el ? `#${host.id} [data-el="${el.dataset.el}"]` : `#${host.id} ${el.tagName.toLowerCase()}`;
    const label = slide ? `${slide} · ${what}` : resolvedOf('overlays', clip) ? `overlay · ${what}` : what;
    return {
      clip, slide, label,
      target: {
        el: el.dataset.el || null,
        selector: inner,
        tag: el.tagName.toLowerCase(),
        text: el === host ? '' : (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        rect: round(elRect(el)),
        ...(el === host && host.tagName === 'VIDEO' ? { src: resolved?.src, mediaTime: r2((resolved?.in || 0) + state.t - resolved.start) } : {}),
      },
    };
  }

  overlay.addEventListener('pointermove', (e) => {
    const p = toCanvas(e);
    $('#coords').textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;
    if (canvasDrag || state.popover || state.mode !== 'comment') return;
    const hit = hitTest(p);
    const prev = state.hover?.el;
    state.hover = hit ? { ...hit, rect: elRect(hit.el), info: describe(hit) } : null;
    if (state.hover?.el !== prev) drawOverlay();
  });
  overlay.addEventListener('pointerleave', () => {
    $('#coords').textContent = '';
    if (state.hover && !canvasDrag) { state.hover = null; drawOverlay(); }
  });

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.project) return;
    const p = toCanvas(e);
    if (state.mode === 'comment') {
      if (state.popover) return closePopover();
      pause();
      const hit = hitTest(p);
      if (!hit) return toast('Nothing on screen here at this moment.');
      openPopover(describe(hit));
    } else if (state.mode === 'adjust') {
      // Overlay frames handle their own drags; empty space deselects.
      if (state.sel?.lane === 'overlays') select(null);
    } else if (state.mode === 'block') {
      pause();
      state.selBlock = null;
      startDraw(e, p);
    } else if (state.mode === 'view') {
      // Clicking the picture selects what's on top there.
      const hit = hitTest(p);
      if (!hit) return select(null);
      const info = describe(hit);
      if (resolvedOf('overlays', info.clip)) select('overlays', info.clip);
      else if (resolvedOf('main', info.clip)) select('main', info.clip);
    }
  });

  function drawOverlay() {
    const nodes = [];
    if (!state.project || !state.pe) { overlay.replaceChildren(); return; }
    const t = state.t;
    if (state.playing) { overlay.replaceChildren(); return; }

    if (state.mode === 'comment' && state.hover && !state.popover) {
      const hl = document.createElement('div');
      hl.className = 'hl' + (state.hover.rect.y < 40 ? ' below' : '');
      place(hl, state.hover.rect);
      hl.innerHTML = '<span class="hl-label"></span>';
      $('span', hl).textContent = state.hover.info.label;
      nodes.push(hl);
    }

    // Overlay frames: always visible as dashed outlines in Adjust; draggable there.
    if (state.mode === 'adjust' || (state.mode === 'view' && state.sel?.lane === 'overlays')) {
      for (const o of model().overlays) {
        if (t < o.start || t >= o.start + o.duration) continue;
        const f = document.createElement('div');
        const sel = state.sel?.lane === 'overlays' && state.sel.id === o.id;
        if (state.mode === 'view' && !sel) continue;
        f.className = 'ov-frame box' + (sel ? ' sel' : '');
        f.dataset.id = o.id;
        place(f, o.box);
        f.innerHTML = `<span class="tag"></span>` + (state.mode === 'adjust' ? ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="h" data-h="${h}"></span>`).join('') : '');
        $('.tag', f).textContent = `${o.kind}${o.text ? ' · ' + o.text.slice(0, 24) : ''}`;
        if (state.mode === 'adjust') f.addEventListener('pointerdown', (e) => startBoxDrag(e, o, e.target.closest('.h')?.dataset.h || 'move'));
        nodes.push(f);
      }
    }

    // Block sketches for this moment.
    const layouts = activeLayouts();
    if (state.mode === 'block') for (const f of layouts) for (const b of f.blocks || []) nodes.push(blockEl(f, b));

    // Pins for comments about this moment.
    if (state.mode !== 'block') {
      const nums = numbers();
      for (const f of state.feedback) {
        if (f.type !== 'comment' || !f.target?.rect || f.time == null) continue;
        if (state.status === 'open' ? f.status !== 'open' : f.status === 'open') continue;
        const until = f.until ?? f.time + 1.5;
        if (t < f.time - 0.05 || t > until) continue;
        const r = f.target.rect;
        const pin = document.createElement('button');
        pin.className = 'pin' + (f.id === state.activeItem ? ' active' : '');
        pin.textContent = nums.get(f.id);
        pin.title = f.comment;
        Object.assign(pin.style, { left: clamp(r.x + r.w, 12, W - 12) * state.scale + 'px', top: clamp(r.y, 12, H - 12) * state.scale + 'px' });
        pin.addEventListener('pointerdown', (e) => e.stopPropagation());
        pin.addEventListener('click', () => { setTab('feedback'); focusItem(f.id); });
        nodes.push(pin);
      }
    }
    if (drawing) nodes.push(drawing.node);
    if (state.popover) nodes.push(state.popover.node);
    overlay.replaceChildren(...nodes);
  }

  // Move / resize an overlay box directly: it is data, not a layout instruction.
  let canvasDrag = null;
  function startBoxDrag(e, o, handle) {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (state.sel?.id !== o.id) select('overlays', o.id);
    const node = $(`.ov-frame[data-id="${CSS.escape(o.id)}"]`);
    canvasDrag = { o, handle, start: toCanvas(e), orig: { ...o.box }, rect: { ...o.box }, node };
    overlay.setPointerCapture(e.pointerId);
  }
  function resizeRect(b, h, dx, dy) {
    const r = { ...b };
    if (h.includes('w')) { r.x = b.x + dx; r.w = b.w - dx; }
    if (h.includes('e')) r.w = b.w + dx;
    if (h.includes('n')) { r.y = b.y + dy; r.h = b.h - dy; }
    if (h.includes('s')) r.h = b.h + dy;
    if (r.w < 20) { if (h.includes('w')) r.x = b.x + b.w - 20; r.w = 20; }
    if (r.h < 20) { if (h.includes('n')) r.y = b.y + b.h - 20; r.h = 20; }
    return r;
  }
  function livePreviewBox(id, r) {
    const box = doc()?.getElementById(id)?.querySelector('.ov-box');
    if (box) Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  }
  overlay.addEventListener('pointermove', (e) => {
    if (!canvasDrag) return;
    if (canvasDrag.block) return moveBlockDrag(e);
    const p = toCanvas(e);
    const dx = p.x - canvasDrag.start.x, dy = p.y - canvasDrag.start.y;
    const r = round(canvasDrag.handle === 'move' ? { ...canvasDrag.orig, x: canvasDrag.orig.x + dx, y: canvasDrag.orig.y + dy } : resizeRect(canvasDrag.orig, canvasDrag.handle, dx, dy));
    canvasDrag.rect = r;
    place(canvasDrag.node, r);
    livePreviewBox(canvasDrag.o.id, r);
    $('#coords').textContent = `${r.x}, ${r.y}  ${r.w}×${r.h}`;
  });
  overlay.addEventListener('pointerup', () => {
    if (drawing) return finishDraw();
    if (!canvasDrag) return;
    const d = canvasDrag;
    canvasDrag = null;
    if (d.block) return endBlockDrag(d);
    if (JSON.stringify(d.rect) === JSON.stringify(d.orig)) return;
    saveBox(d.o.id, d.rect);
  });
  function saveBox(id, r) {
    saveEdit((edit) => { itemIn(edit, 'overlays', id).box = { ...r }; });
  }

  // ---------- comments ----------
  function openPopover(info, range = null) {
    const node = document.createElement('div');
    node.className = 'pop';
    const time = range ? r2(range.from) : r2(state.t);
    const until = range ? r2(range.to) : null;
    const chip = until != null ? `<span class="fb-time range" title="Comment is about this stretch">${fmt(time)}–${fmt(until)}</span>` : `<span class="fb-time" title="Comment is about this moment">at ${fmt(time)}</span>`;
    node.innerHTML = `
      <div class="pop-head">
        <code></code>${chip}
        ${info.parent ? '<button class="icon-btn" data-act="parent" title="Select the parent element"><svg><use href="#i-parent"/></svg></button>' : ''}
        <button class="icon-btn" data-act="close" title="Cancel (Esc)"><svg><use href="#i-close"/></svg></button>
      </div>
      <textarea placeholder="${range ? 'e.g. &quot;cut this pause&quot; or &quot;music should drop here&quot;' : 'e.g. &quot;animate the product here&quot; or &quot;title is too long&quot;'}"></textarea>
      <div class="pop-foot"><span class="tip">Ctrl+Enter to save</span><button class="btn btn-primary" data-act="save">Add comment</button></div>`;
    $('code', node).textContent = info.label;
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    const ta = $('textarea', node);
    ta.spellcheck = false;
    node.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') closePopover();
      if (act === 'save') submitComment();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment();
      if (e.key === 'Escape') closePopover();
    });
    state.popover = { node, info, time, until };
    const s = state.scale, r = info.target.rect || { x: 40, y: 40, w: 0, h: 0 };
    const pw = 320, ph = 190;
    let left = r.x * s, top = (r.y + r.h) * s + 8;
    if (top + ph > H * s) top = Math.max(8, r.y * s - ph - 8);
    if (top + ph > H * s) top = 8;
    left = Math.min(Math.max(8, left), W * s - pw - 8);
    Object.assign(node.style, { left: left + 'px', top: top + 'px' });
    state.hover = null;
    drawOverlay();
    ta.focus();
  }
  function openRangePopover() {
    const r = state.range;
    const clip = model().main.find((c) => r.from >= c.start && r.from < c.start + c.duration);
    openPopover({ clip: clip?.id || null, slide: null, label: clip ? `stretch of ${clip.src || clip.deck || clip.scene}` : 'stretch of the video', target: { el: null, selector: 'timeline', tag: null, text: '', rect: null } }, r);
  }
  function closePopover() {
    if (!state.popover) return;
    state.popover = null;
    state.range = null;
    drawRange();
    drawOverlay();
  }
  async function submitComment() {
    const pop = state.popover;
    const comment = $('textarea', pop.node).value.trim();
    if (!comment) return $('textarea', pop.node).focus();
    try {
      const body = { type: 'comment', clip: pop.info.clip, target: pop.info.target, comment, time: pop.time };
      if (pop.info.slide) body.slide = pop.info.slide;
      if (pop.until != null) body.until = pop.until;
      const item = await saveItem('POST', '', body);
      state.popover = null;
      state.range = null;
      state.activeItem = item.id;
      drawRange();
      afterFeedbackChange();
      setTab('feedback');
    } catch (err) { toast(`Comment not saved: ${err.message}`, true); }
  }

  // ---------- block sketches (per moment) ----------
  function activeLayouts() {
    return state.feedback.filter((f) => f.type === 'layout' && f.status === 'open' && f.time != null && state.t >= f.time - 0.05 && state.t <= (f.until ?? f.time + 3));
  }
  let drawing = null;
  function startDraw(e, p) {
    const node = document.createElement('div');
    node.className = 'drawing';
    drawing = { start: p, node, rect: { x: p.x, y: p.y, w: 0, h: 0 } };
    overlay.setPointerCapture(e.pointerId);
    drawOverlay();
  }
  overlay.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = toCanvas(e), s = drawing.start;
    drawing.rect = { x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    place(drawing.node, drawing.rect);
  });
  async function finishDraw() {
    const r = round(drawing.rect);
    drawing = null;
    if (r.w < 24 || r.h < 24) return drawOverlay();
    const block = { id: 'b' + Math.random().toString(16).slice(2, 7), label: '', ...r };
    const current = activeLayouts()[0];
    try {
      if (current) await saveItem('PATCH', current.id, { blocks: [...current.blocks, block] });
      else {
        const clip = model().main.find((c) => state.t >= c.start && state.t < c.start + c.duration);
        await saveItem('POST', '', { type: 'layout', time: r2(state.t), until: r2(Math.min(duration(), state.t + 3)), clip: clip?.id || null, blocks: [block], comment: '' });
      }
      state.selBlock = block.id;
      afterFeedbackChange();
      requestAnimationFrame(() => $(`.block[data-id="${block.id}"] input`)?.focus());
    } catch (err) { toast(err.message, true); drawOverlay(); }
  }
  function blockEl(f, b) {
    const el = document.createElement('div');
    el.className = 'block' + (state.selBlock === b.id ? ' sel' : '');
    el.dataset.id = b.id;
    place(el, b);
    el.innerHTML = `<input placeholder="What goes here?" aria-label="Block label"><button class="x" title="Delete block"><svg><use href="#i-close"/></svg></button><span class="dims">${b.w}×${b.h}</span>` +
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<span class="h" data-h="${h}"></span>`).join('');
    const input = $('input', el);
    input.value = b.label || '';
    input.spellcheck = false;
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') input.blur(); });
    input.addEventListener('change', () => patchBlock(f, b.id, { label: input.value.trim() }));
    $('.x', el).addEventListener('pointerdown', (e) => e.stopPropagation());
    $('.x', el).addEventListener('click', () => deleteBlock(f, b.id));
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      state.selBlock = b.id;
      $$('.block.sel').forEach((n) => n.classList.remove('sel'));
      el.classList.add('sel');
      canvasDrag = { block: true, f, b, handle: e.target.closest('.h')?.dataset.h || 'move', start: toCanvas(e), orig: { x: b.x, y: b.y, w: b.w, h: b.h }, node: el };
      overlay.setPointerCapture(e.pointerId);
    });
    return el;
  }
  function moveBlockDrag(e) {
    const d = canvasDrag, p = toCanvas(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    d.rect = round(d.handle === 'move' ? { ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy } : resizeRect(d.orig, d.handle, dx, dy));
    place(d.node, d.rect);
    $('.dims', d.node).textContent = `${d.rect.w}×${d.rect.h}`;
  }
  function endBlockDrag(d) {
    if (!d.rect) return;
    patchBlock(d.f, d.b.id, d.rect);
  }
  function patchBlock(f, id, changes) {
    const blocks = f.blocks.map((b) => (b.id === id ? { ...b, ...changes } : b));
    saveItem('PATCH', f.id, { blocks }).then(() => { renderPanel(); drawOverlay(); }).catch((e) => toast(e.message, true));
  }
  async function deleteBlock(f, id) {
    const blocks = f.blocks.filter((b) => b.id !== id);
    try {
      if (blocks.length) await saveItem('PATCH', f.id, { blocks });
      else await saveItem('DELETE', f.id);
      state.selBlock = null;
      afterFeedbackChange();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- ruler: feedback markers + range ----------
  function numbers() {
    const map = new Map();
    state.feedback.forEach((f, i) => map.set(f.id, i + 1));
    return map;
  }
  function drawMarkers() {
    const ruler = $('#ruler');
    $$('.marker', ruler).forEach((m) => m.remove());
    const nums = numbers();
    for (const f of state.feedback) {
      if (f.time == null) continue;
      const m = document.createElement('button');
      m.className = 'marker' + (f.until != null && f.type === 'comment' ? ' range' : '') + (f.type === 'layout' ? ' layout' : '') + (f.status !== 'open' ? ' done' : '');
      m.style.left = x(f.time) + 'px';
      if (f.until != null && f.type === 'comment') m.style.width = Math.max(16, (f.until - f.time) * state.pps) + 'px';
      m.textContent = nums.get(f.id);
      m.title = `${fmt(f.time)}${f.until != null ? '–' + fmt(f.until) : ''}: ${f.comment || (f.blocks || []).map((b) => b.label || 'block').join(', ')}`;
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('click', () => { pause(); seek(f.time); setTab('feedback'); focusItem(f.id); });
      ruler.append(m);
    }
  }
  function drawRange() {
    const el = $('#rangeSel');
    if (!el) return;
    el.hidden = !state.range;
    if (state.range) Object.assign(el.style, { left: x(state.range.from) + 'px', width: (state.range.to - state.range.from) * state.pps + 'px' });
  }

  // ---------- feedback panel ----------
  const KIND = { comment: 'Comment', adjust: 'Move & resize', layout: 'Sketch' };
  function renderPanel() {
    if (!state.project) return;
    const all = state.feedback;
    $('#countAll').textContent = all.filter((f) => f.status === 'open').length;
    $('#countOpen').textContent = all.filter((f) => f.status === 'open').length;
    $('#countDone').textContent = all.filter((f) => f.status !== 'open').length;
    const nums = numbers();
    const items = all.filter((f) => (state.status === 'open' ? f.status === 'open' : f.status !== 'open'))
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    const list = $('#fbList');
    if (!items.length) {
      list.innerHTML = state.status === 'open'
        ? '<li class="fb-empty"><p>Nothing open on this video.</p><p class="sub">Press <kbd>C</kbd>, pause on a moment and click what\'s wrong, or drag along the ruler to comment on a stretch. <kbd>B</kbd> sketches what should appear on screen.</p></li>'
        : '<li class="fb-empty"><p>Nothing applied yet.</p><p class="sub">When Claude applies feedback it moves here with a note on what changed.</p></li>';
      return;
    }
    list.replaceChildren(...items.map((f) => {
      const li = document.createElement('li');
      li.className = 'fb-item' + (f.id === state.activeItem ? ' active' : '');
      li.dataset.id = f.id;
      li.dataset.type = f.type;
      li.dataset.status = f.status;
      const when = f.time == null ? '' : f.until != null && f.type === 'comment' ? `<span class="fb-time range">${fmt(f.time)}–${fmt(f.until)}</span>` : `<span class="fb-time">at ${fmt(f.time)}</span>`;
      const target = f.type === 'layout' ? `${f.blocks?.length || 0} block${f.blocks?.length === 1 ? '' : 's'}` : (f.slide ? `${f.slide} · ` : '') + (f.target?.el || (f.target?.selector === 'timeline' ? 'stretch' : f.target?.src ? 'footage' : f.target?.tag) || '');
      li.innerHTML = `
        <div class="fb-top"><span class="fb-num"></span><span class="fb-kind"></span><span class="fb-target"></span>${when}</div>
        <textarea rows="2"></textarea>
        ${f.type === 'layout' && f.blocks?.length ? `<p class="fb-meta">${f.blocks.map((b) => esc(b.label || 'unnamed')).join(' · ')}</p>` : ''}
        ${f.resolution ? '<p class="fb-resolution"><b>Claude:</b> </p>' : ''}
        <div class="fb-actions">
          ${f.status === 'open' ? '' : '<button class="icon-btn" data-act="reopen" title="Reopen"><svg><use href="#i-reopen"/></svg></button>'}
          <button class="icon-btn" data-act="delete" title="Delete"><svg><use href="#i-trash"/></svg></button>
        </div>`;
      $('.fb-num', li).textContent = nums.get(f.id);
      $('.fb-kind', li).textContent = KIND[f.type];
      $('.fb-target', li).textContent = target;
      if (f.resolution) $('.fb-resolution', li).append(f.resolution);
      const ta = $('textarea', li);
      ta.value = f.comment || '';
      ta.placeholder = f.type === 'comment' ? 'Comment' : 'Optional: notes for this sketch';
      ta.disabled = f.status !== 'open';
      ta.addEventListener('change', () => saveItem('PATCH', f.id, { comment: ta.value.trim() }).catch((e) => toast(e.message, true)));
      li.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'delete') return saveItem('DELETE', f.id).then(afterFeedbackChange).catch((er) => toast(er.message, true));
        if (act === 'reopen') return saveItem('PATCH', f.id, { status: 'open' }).then(afterFeedbackChange);
        if (e.target === ta) return;
        if (f.time != null) { pause(); seek(f.time); }
        if (f.type === 'layout' && state.mode !== 'block') setMode('block');
        focusItem(f.id, false);
      });
      return li;
    }));
  }
  function focusItem(id, scroll = true) {
    state.activeItem = id;
    const f = state.feedback.find((x) => x.id === id);
    if (f && (state.status === 'open') !== (f.status === 'open')) {
      state.status = f.status === 'open' ? 'open' : 'done';
      syncStatusTabs();
    }
    renderPanel();
    drawOverlay();
    const li = $(`.fb-item[data-id="${id}"]`);
    if (scroll) li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function afterFeedbackChange() {
    renderPanel();
    drawMarkers();
    drawOverlay();
    updatePanelCount();
  }
  function syncStatusTabs() {
    $$('[data-status]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.status === state.status)));
  }
  $$('[data-status]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; syncStatusTabs(); renderPanel(); drawOverlay(); }));

  // ---------- panel toggle ----------
  function setPanel(show) {
    document.body.classList.toggle('panel-off', !show);
    $('#togglePanel').setAttribute('aria-pressed', String(show));
    try { localStorage.setItem('ps-edit-panel', show ? 'on' : 'off'); } catch { /* storage unavailable */ }
    updatePanelCount();
    requestAnimationFrame(() => { fit(); if (state.fitZoom) renderTimeline(); });
  }
  function updatePanelCount() {
    const badge = $('#panelCount');
    const open = state.feedback.filter((f) => f.status === 'open').length;
    badge.hidden = !document.body.classList.contains('panel-off') || !open;
    badge.textContent = open;
  }
  $('#togglePanel').addEventListener('click', () => setPanel(document.body.classList.contains('panel-off')));
  try { if (localStorage.getItem('ps-edit-panel') === 'off') document.body.classList.add('panel-off'), $('#togglePanel').setAttribute('aria-pressed', 'false'); } catch { /* storage unavailable */ }

  // ---------- keyboard ----------
  let nudgeTimer = null;
  document.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input:not([type="range"]):not([type="checkbox"]), textarea, select');
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      if (!$('#newForm').hidden) showNewForm(false);
      closePopover();
      state.selBlock = null;
      return drawOverlay();
    }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); return undo(e.shiftKey); }
      if (k === 'y') { e.preventDefault(); return undo(true); }
      return;
    }
    if (e.altKey || !state.project) return;
    const k = e.key.toLowerCase();
    const modeKey = { v: 'view', c: 'comment', a: 'adjust', b: 'block' }[k];
    if (modeKey) return setMode(modeKey);
    if (k === 'f') return setPanel(document.body.classList.contains('panel-off'));
    if (k === 's') return split();
    if (e.key === '+' || e.key === '=') return setZoom(state.pps * 1.5);
    if (e.key === '-') return setZoom(state.pps / 1.5);
    if (e.key === '0') return setZoom(fitPps(), true);
    if (e.key === ' ') {
      if (e.target.matches('button')) return;
      e.preventDefault();
      return state.playing ? pause() : play();
    }
    if (state.mode === 'adjust' && state.sel?.lane === 'overlays' && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const o = selected();
      const step = e.shiftKey ? 10 : 1;
      o.box = { ...o.box };
      if (e.key === 'ArrowLeft') o.box.x -= step;
      if (e.key === 'ArrowRight') o.box.x += step;
      if (e.key === 'ArrowUp') o.box.y -= step;
      if (e.key === 'ArrowDown') o.box.y += step;
      livePreviewBox(o.id, o.box);
      drawOverlay();
      clearTimeout(nudgeTimer);
      const id = o.id, box = { ...o.box };
      nudgeTimer = setTimeout(() => saveBox(id, box), 400);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.mode === 'block' && state.selBlock) {
        const f = activeLayouts().find((l) => l.blocks.some((b) => b.id === state.selBlock));
        if (f) return deleteBlock(f, state.selBlock);
      }
      return removeSelected();
    }
    const fps = state.project.edit.fps || 30;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      pause();
      const d = (e.shiftKey ? 1 : 1 / fps) * (e.key === 'ArrowRight' ? 1 : -1);
      return seek(state.t + d);
    }
    if (e.key === 'Home') { e.preventDefault(); return seek(0); }
    if (e.key === 'End') { e.preventDefault(); return seek(duration()); }
  });

  // ---------- top bar actions ----------
  $('#copyPrompt').addEventListener('click', async () => {
    if (!vid()) return;
    const open = state.feedback.filter((f) => f.status === 'open').length;
    const text = `/apply-feedback video ${vid()}`;
    try { await navigator.clipboard.writeText(text); toast(`Copied "${text}" (${open} open item${open === 1 ? '' : 's'}). Paste it into Claude Code.`); }
    catch { toast(text); }
  });
  $('#renderBtn').addEventListener('click', async () => {
    if (!vid()) return;
    if (!state.project.edit.main.length) return toast('Nothing to render yet: put something on the main track.');
    try {
      await api('POST', `/api/videos/${vid()}/render`, {});
      toast('Rendering from the original footage. Keep working; it lands in exports/videos/.');
    } catch (err) { toast(`Render not started: ${err.message}`, true); }
  });
  function onRender(ev) {
    if (ev.video !== vid()) return;
    const btn = $('#renderBtn');
    const label = $('span', btn);
    if (ev.state === 'running') {
      btn.classList.add('busy');
      btn.disabled = true;
      label.textContent = `Rendering ${ev.percent || 0}%`;
      return;
    }
    btn.classList.remove('busy');
    btn.disabled = false;
    label.textContent = 'Render MP4';
    if (ev.state === 'done') toast(`Video ready, ${fmt(ev.duration)}.`, false, { href: ev.url, text: 'Open video' });
    if (ev.state === 'error') toast(`Render failed: ${ev.message}`, true);
  }

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
    toastTimer = setTimeout(() => { t.hidden = true; }, link ? 8000 : error ? 6000 : 3500);
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
      if (ev.type === 'render') onRender(ev);
      if (ev.type === 'media' && ev.video === vid()) onMedia(ev);
    };
  }
  function onMedia(ev) {
    if (!state.project) return;
    state.project.media[ev.name] = { ...state.project.media[ev.name], ...ev };
    renderBin();
    if (ev.status === 'error') toast(`${ev.name}: ${ev.error}`, true);
    if (ev.status === 'ready') refreshProject({ preview: true }).catch(() => {});
  }
  let changeTimer = null, previewNeeded = false;
  async function onChange({ scope, path }) {
    if (scope === 'studio') { if (/editor|edit-runtime|studio\.css/.test(path)) location.reload(); return; }
    if (!vid()) return;
    if (scope === 'decks' && path.endsWith('feedback.json')) return;
    if (scope === 'profile' || scope === 'decks') { previewNeeded = true; return schedule(); }
    const [id, ...rest] = path.split('/');
    if (scope !== 'videos' || id !== vid()) return;
    const file = rest.join('/');
    if (file === 'feedback.json') {
      if (Date.now() - lastLocalWrite < 800) return;
      if (document.activeElement?.matches('textarea, .block input')) return;
      state.feedback = await api('GET', fbUrl());
      return afterFeedbackChange();
    }
    if (file === 'edit.json' && Date.now() - lastLocalWrite < 800) return;
    if (file.startsWith('scenes/')) previewNeeded = true;
    if (file === 'edit.json' || file === 'media.json' || file.startsWith('scenes/')) schedule();
  }
  function schedule() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(async () => {
      const preview = previewNeeded;
      previewNeeded = false;
      const changed = await refreshProject({ preview }).catch(() => false);
      if (changed) toast('The edit changed on disk (Claude?). Showing the new version.');
    }, 200);
  }

  // ---------- boot ----------
  (async () => {
    setMode('view');
    setTab('clip');
    fit();
    try {
      [state.list, state.decks] = await Promise.all([api('GET', '/api/videos'), api('GET', '/api/decks')]);
      connect();
      const want = new URLSearchParams(location.search).get('v');
      const pick = state.list.find((p) => p.id === want) || state.list[0];
      renderProjectSelect();
      if (!pick) {
        renderBin();
        const empty = $('#emptyStage');
        empty.hidden = false;
        empty.innerHTML = '<h2>No videos yet</h2><p>Name your first one in the top bar, then import your footage.</p>';
        showNewForm(true);
        return;
      }
      await loadProject(pick.id);
    } catch (err) {
      toast(`Could not load: ${err.message}`, true);
    }
  })();
})();
