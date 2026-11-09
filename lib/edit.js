// Video projects: the owner's own footage cut together with deck scenes, AI-made
// animation scenes and overlays (titles, labels, arrows...) on top.
//
// videos/<id>/edit.json   the edit (see CLAUDE.md "Video projects" for the schema)
// videos/<id>/media.json  server-owned index of imported files (probe info, proxy status)
// videos/<id>/media/      originals (+ .proxy/ 720p previews, .thumbs/)
// videos/<id>/scenes/     <name>.html (+ optional <name>.js) animation scenes Claude writes
//
// One markup generator feeds both the studio preview (proxies, live server URLs) and the
// HyperFrames render (originals, project-relative URLs), so the two always agree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, DECKS, SLUG, readJSON, loadDeck, slideFragment, sceneDuration } = require('./deck');
const { runHyperframes } = require('./video');
const { processMedia, kindOf, uniqueName, proxyPath, thumbPath } = require('./media');

const VIDEOS = path.join(ROOT, 'videos');
const PROFILE = path.join(ROOT, 'profile');
const EXPORTS = path.join(ROOT, 'exports');
const W = 1920, H = 1080;
const OVERLAY_KINDS = ['title', 'lower', 'label', 'arrow', 'highlight', 'image', 'anim'];
const ANIMS = ['fade', 'rise', 'slide', 'pop', 'wipe', 'none'];

const r2 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

function videoDir(id) {
  if (!SLUG.test(id || '')) return null;
  const dir = path.join(VIDEOS, id);
  return fs.existsSync(path.join(dir, 'edit.json')) ? dir : null;
}
function editFile(id) { return path.join(VIDEOS, id, 'edit.json'); }
function mediaDir(id) { return path.join(VIDEOS, id, 'media'); }

function loadEdit(id) {
  const dir = videoDir(id);
  if (!dir) return null;
  const raw = fs.readFileSync(path.join(dir, 'edit.json'), 'utf8');
  let edit;
  try { edit = JSON.parse(raw); } catch (e) { throw new Error(`videos/${id}/edit.json is not valid JSON: ${e.message}`); }
  edit.main = Array.isArray(edit.main) ? edit.main : [];
  edit.overlays = Array.isArray(edit.overlays) ? edit.overlays : [];
  edit.audio = Array.isArray(edit.audio) ? edit.audio : [];
  return { edit, rev: revOf(raw) };
}
function loadMedia(id) { return readJSON(path.join(VIDEOS, id, 'media.json'), {}); }

function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function createProject(id, title) {
  if (!SLUG.test(id || '')) throw new Error('Project id: letters, digits, - and _ only.');
  const dir = path.join(VIDEOS, id);
  if (fs.existsSync(path.join(dir, 'edit.json'))) throw new Error(`videos/${id} already exists.`);
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true });
  writeJSON(path.join(dir, 'edit.json'), { title: title || id, fps: 30, main: [], overlays: [], audio: [] });
  return loadEdit(id);
}

// media.json is written by imports that may run in parallel: queue writes per project.
const mediaQueues = new Map();
function updateMedia(id, fn) {
  const next = (mediaQueues.get(id) || Promise.resolve()).then(() => {
    const index = loadMedia(id);
    fn(index);
    writeJSON(path.join(VIDEOS, id, 'media.json'), index);
    return index;
  });
  mediaQueues.set(id, next.catch(() => {}));
  return next;
}

// Probe + proxy + thumbnail one file already in videos/<id>/media/, and index it.
async function importMedia(id, name, { onStatus } = {}) {
  const kind = kindOf(name);
  if (!kind) throw new Error(`Not a video, audio or image file: ${name}`);
  await updateMedia(id, (ix) => { ix[name] = { ...ix[name], kind, status: 'processing' }; });
  onStatus?.({ name, kind, status: 'processing' });
  try {
    const info = await processMedia(mediaDir(id), name);
    const entry = { ...info, proxy: kind === 'video', thumb: kind === 'video', importedAt: new Date().toISOString() };
    await updateMedia(id, (ix) => { ix[name] = entry; });
    onStatus?.({ name, ...entry });
    return entry;
  } catch (e) {
    await updateMedia(id, (ix) => { ix[name] = { kind, status: 'error', error: e.message }; });
    onStatus?.({ name, kind, status: 'error', error: e.message });
    throw e;
  }
}
function removeMedia(id, name) {
  return updateMedia(id, (ix) => { delete ix[name]; });
}
function revOf(raw) { return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12); }

function listScenes(id) {
  const dir = path.join(VIDEOS, id, 'scenes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).filter((n) => SLUG.test(n));
}
function sceneHtml(id, name) {
  try { return fs.readFileSync(path.join(VIDEOS, id, 'scenes', `${name}.html`), 'utf8'); } catch {
    return `<section class="anim ps-missing"><p>Missing scene: scenes/${esc(name)}.html</p></section>`;
  }
}

// ---------- timing ----------

// Absolute times for everything. Main-track items play back to back; overlays and
// audio carry their own start. Problems (missing media, bad trims) are collected as
// warnings instead of throwing, so a half-made edit still previews.
function resolve(id, edit, media = loadMedia(id)) {
  const warnings = [];
  let t = 0;
  const main = edit.main.map((item, i) => {
    const out = { ...item, index: i };
    if (item.type === 'media') {
      const info = media[item.src];
      if (!info) warnings.push(`${item.id}: media "${item.src}" is not imported`);
      if (info?.kind === 'image') {
        out.duration = num(item.duration, 4);
      } else {
        const full = info?.duration ?? num(item.out, 5);
        const a = Math.max(0, num(item.in, 0));
        const b = Math.min(full, num(item.out, full));
        if (b - a < 0.1) warnings.push(`${item.id}: trim leaves nothing to play`);
        out.in = a; out.out = b; out.duration = Math.max(0.1, b - a);
      }
      out.kind = info?.kind || 'video';
    } else if (item.type === 'deck') {
      const meta = loadDeck(item.deck);
      if (!meta) { warnings.push(`${item.id}: unknown deck "${item.deck}"`); out.slides = []; out.duration = 1; }
      else {
        const ids = (Array.isArray(item.slides) && item.slides.length ? item.slides : meta.slides).filter((s) => meta.slides.includes(s));
        let s0 = 0;
        out.slides = ids.map((sid) => {
          const html = slideFragment(meta, sid);
          const d = num(item.durations?.[sid], sceneDuration(meta, sid, html));
          const slide = { id: sid, start: r2(t + s0), duration: d, html };
          s0 += d;
          return slide;
        });
        out.duration = s0 || 1;
      }
    } else if (item.type === 'scene') {
      out.duration = num(item.duration, 5);
      if (!fs.existsSync(path.join(VIDEOS, id, 'scenes', `${item.scene}.html`))) warnings.push(`${item.id}: scene "${item.scene}" has no scenes/${item.scene}.html yet`);
    } else {
      warnings.push(`${item.id || `main[${i}]`}: unknown type "${item.type}"`);
      out.duration = 0;
    }
    out.start = r2(t);
    out.duration = r2(out.duration);
    t += out.duration;
    return out;
  });
  const duration = r2(t);
  const overlays = edit.overlays.map((o, i) => {
    const out = { ...o, index: i, start: r2(Math.max(0, num(o.start, 0))), duration: r2(Math.max(0.2, num(o.duration, 3))) };
    out.box = { x: num(o.box?.x, 120), y: num(o.box?.y, 120), w: num(o.box?.w, 800), h: num(o.box?.h, 200) };
    out.anim = ANIMS.includes(o.anim) ? o.anim : 'rise';
    if (!OVERLAY_KINDS.includes(o.kind)) warnings.push(`${o.id}: unknown overlay kind "${o.kind}"`);
    if (out.start >= duration && duration > 0) warnings.push(`${o.id}: starts after the video ends (${duration}s)`);
    return out;
  });
  const audio = edit.audio.map((a, i) => {
    const info = media[a.src];
    if (!info) warnings.push(`${a.id}: audio "${a.src}" is not imported`);
    const full = info?.duration ?? num(a.out, 10);
    const inn = Math.max(0, num(a.in, 0));
    const outp = Math.min(full, num(a.out, full));
    const start = Math.max(0, num(a.start, 0));
    // Music never runs past the end of the picture.
    const len = Math.max(0.1, Math.min(outp - inn, Math.max(0.1, duration - start)));
    return { ...a, index: i, start: r2(start), in: inn, out: r2(inn + len), duration: r2(len) };
  });
  return { duration, main, overlays, audio, warnings };
}

// ---------- markup ----------

// url(kind, rel): where a file lives for this mode. kinds: media, proxy, deck-asset.
function urls(id, mode) {
  if (mode === 'render') {
    return {
      media: (name) => `media/${name}`,
      proxy: (name) => `media/${name}`,
      deck: (deck, rel) => `decks/${deck}/${rel}`,
    };
  }
  const media = loadMedia(id);
  return {
    media: (name) => `/videos/${id}/media/${encodeURIComponent(name)}`,
    proxy: (name) => (media[name]?.proxy ? `/videos/${id}/media/.proxy/${encodeURIComponent(name.replace(/\.[^.]+$/, '.mp4'))}` : `/videos/${id}/media/${encodeURIComponent(name)}`),
    deck: (deck, rel) => `/decks/${deck}/${rel}`,
  };
}

function overlayInner(o, u) {
  const text = esc(o.text), sub = esc(o.sub);
  switch (o.kind) {
    case 'title': return `<div class="ov ov-title" data-el="${esc(o.id)}"><h2>${text}</h2>${sub ? `<p>${sub}</p>` : ''}</div>`;
    case 'lower': return `<div class="ov ov-lower" data-el="${esc(o.id)}"><strong>${text}</strong>${sub ? `<span>${sub}</span>` : ''}</div>`;
    case 'label': return `<div class="ov ov-label" data-el="${esc(o.id)}">${text}</div>`;
    case 'arrow': return `<div class="ov ov-arrow ${esc(o.dir || 'right')}" data-el="${esc(o.id)}"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M6 41h58L42 19h26l28 31-28 31H42l22-22H6z"/></svg>${text ? `<span>${text}</span>` : ''}</div>`;
    case 'highlight': return `<div class="ov ov-highlight" data-el="${esc(o.id)}">${text ? `<span>${text}</span>` : ''}</div>`;
    case 'image': return `<div class="ov ov-image" data-el="${esc(o.id)}"><img src="${esc(u.media(o.src))}" alt=""></div>`;
    default: return `<div class="ov ov-label" data-el="${esc(o.id)}">${text || esc(o.kind)}</div>`;
  }
}

// Returns { body, plan, duration, decks, scenes, media } for a resolved edit.
function buildMarkup(id, model, { mode = 'preview' } = {}) {
  const u = urls(id, mode);
  const plan = [];
  const decks = new Set(), scenes = new Set(), used = new Set();
  const clips = [];
  const last = model.main.length - 1;
  let z = 1;

  model.main.forEach((item, i) => {
    const base = `id="${esc(item.id)}" data-start="${item.start}" data-duration="${item.duration}" data-track-index="0"`;
    if (item.type === 'media' && item.kind === 'image') {
      used.add(item.src);
      clips.push(`<img class="clip main-media" ${base} src="${esc(u.media(item.src))}" alt="" style="z-index:${z++}">`);
    } else if (item.type === 'media') {
      used.add(item.src);
      const vol = num(item.volume, 1);
      const sound = item.muted || vol === 0 ? 'muted' : `data-has-audio="true" data-volume="${vol}"`;
      // Footage without an audio stream must be muted or HyperFrames refuses it.
      const hasAudio = loadMediaCached(id)[item.src]?.hasAudio !== false;
      clips.push(`<video class="clip main-media" ${base} data-media-start="${item.in}" ${hasAudio ? sound : 'muted'} playsinline preload="auto" src="${esc(u.proxy(item.src))}" style="z-index:${z++}"></video>`);
    } else if (item.type === 'deck') {
      decks.add(item.deck);
      item.slides.forEach((s, j) => {
        const sid = `${item.id}-${s.id}`;
        const html = s.html.replace(/(src|href)="assets\//g, (_, a) => `${a}="${u.deck(item.deck, 'assets/')}`);
        clips.push(`<div class="clip slide-clip" id="${esc(sid)}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0" style="z-index:${z++}">\n${html}\n</div>`);
        plan.push({ kind: 'slide', id: sid, start: s.start, duration: s.duration, exit: !(i === last && j === item.slides.length - 1) });
      });
    } else if (item.type === 'scene') {
      scenes.add(item.scene);
      clips.push(`<div class="clip anim-clip" ${base} style="z-index:${z++}">\n${sceneHtml(id, item.scene)}\n</div>`);
      plan.push({ kind: 'scene', id: item.id, name: item.scene, start: item.start, duration: item.duration });
    }
  });

  model.overlays.forEach((o, i) => {
    if (o.kind === 'anim') scenes.add(o.scene);
    if (o.kind === 'image') used.add(o.src);
    const { x, y, w, h } = o.box;
    const inner = o.kind === 'anim'
      ? `<div class="ov ov-anim" data-el="${esc(o.id)}">${sceneHtml(id, o.scene)}</div>`
      : overlayInner(o, u);
    // The clip itself is full-frame (HyperFrames lays out timed root children that way);
    // the box positions the overlay inside it.
    clips.push(`<div class="clip overlay-clip" id="${esc(o.id)}" data-start="${o.start}" data-duration="${o.duration}" data-track-index="${i + 1}" style="z-index:${100 + i}">
  <div class="ov-box" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">${inner}</div>
</div>`);
    plan.push({ kind: o.kind === 'anim' ? 'overlay-anim' : 'overlay', id: o.id, name: o.scene, start: o.start, duration: o.duration, anim: o.anim });
  });

  model.audio.forEach((a, i) => {
    used.add(a.src);
    clips.push(`<audio class="clip" id="${esc(a.id)}" data-start="${a.start}" data-duration="${a.duration}" data-media-start="${a.in}" data-volume="${num(a.volume, 1)}" data-track-index="${50 + i}" preload="auto" src="${esc(u.media(a.src))}"></audio>`);
  });

  return { body: clips.join('\n'), plan, duration: model.duration, decks: [...decks], scenes: [...scenes], media: [...used] };
}

let mediaCache = { id: null, at: 0, value: {} };
function loadMediaCached(id) {
  if (mediaCache.id !== id || Date.now() - mediaCache.at > 500) mediaCache = { id, at: Date.now(), value: loadMedia(id) };
  return mediaCache.value;
}

// The script both modes share: one paused GSAP timeline built from the plan.
function timelineScript(plan, duration) {
  return `<script>
  (function () {
    var tl = gsap.timeline({ paused: true });
    var plan = ${JSON.stringify(plan)};
    plan.forEach(function (s) {
      var host = document.getElementById(s.id);
      if (!host) return;
      if (s.kind === 'slide') PitchMotion.build(tl, host.querySelector('section.slide'), s.start, s.duration, { exit: s.exit });
      else if (s.kind === 'scene') PitchScenes.run(s.name, tl, host.querySelector('.anim') || host, s.start, s.duration);
      else if (s.kind === 'overlay-anim') { PitchMotion.overlay(tl, host.querySelector('.ov'), s.start, s.duration, 'fade'); PitchScenes.run(s.name, tl, host.querySelector('.anim') || host, s.start, s.duration); }
      else PitchMotion.overlay(tl, host.querySelector('.ov'), s.start, s.duration, s.anim);
    });
    tl.set({}, {}, ${duration});
    window.__timelines = window.__timelines || {};
    window.__timelines.root = tl;
  })();
</script>`;
}

const PAGE_CSS = `
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
  .main-media { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; object-fit: contain; background: #000; }
  .slide-clip, .anim-clip, .overlay-clip { position: absolute; inset: 0; }
  .slide-clip { background: var(--platform, #e4e7e9); }
  /* Full-frame clip, but only the overlay itself catches the pointer (studio comments). */
  .overlay-clip { pointer-events: none; }
  .ov-box { position: absolute; pointer-events: auto; }
`;

// Full page. Preview adds the studio runtime (media sync + transport) and live URLs.
function editPage(id, { mode = 'preview' } = {}) {
  const loaded = loadEdit(id);
  if (!loaded) return null;
  const model = resolve(id, loaded.edit);
  const m = buildMarkup(id, model, { mode });
  const preview = mode === 'preview';
  const fps = num(loaded.edit.fps, 30);
  const deckCss = m.decks.filter((d) => fs.existsSync(path.join(DECKS, d, 'deck.css')))
    .map((d) => `<link rel="stylesheet" href="${preview ? `/decks/${d}/deck.css` : `decks/${d}/deck.css`}">`).join('\n');
  const sceneCss = m.scenes.filter((n) => fs.existsSync(path.join(VIDEOS, id, 'scenes', `${n}.css`)))
    .map((n) => `<link rel="stylesheet" href="${preview ? `/videos/${id}/scenes/${n}.css` : `scenes/${n}.css`}">`).join('\n');
  const sceneJs = m.scenes.filter((n) => fs.existsSync(path.join(VIDEOS, id, 'scenes', `${n}.js`)))
    .map((n) => `<script src="${preview ? `/videos/${id}/scenes/${n}.js` : `scenes/${n}.js`}"></script>`).join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(loaded.edit.title || id)}</title>
${preview ? `<base href="/videos/${id}/">` : ''}
<link rel="stylesheet" href="${preview ? '/profile/theme.css' : 'profile/theme.css'}">
${deckCss}
${sceneCss}
<style>${PAGE_CSS}</style>
</head><body class="ps-render ps-edit">
<div id="root" data-composition-id="root" data-width="${W}" data-height="${H}" data-fps="${fps}" data-duration="${m.duration}">
${m.body}
</div>
<script src="${preview ? '/vendor/gsap.min.js' : 'gsap.min.js'}"></script>
<script src="${preview ? '/profile/motion.js' : 'profile/motion.js'}"></script>
${sceneJs}
${timelineScript(m.plan, m.duration)}
${preview ? `<script>window.__peModel = ${JSON.stringify({ duration: m.duration, warnings: model.warnings })};</script>\n<script src="/studio/edit-runtime.js"></script>` : ''}
</body></html>`;
  return { html, model, markup: m, fps, rev: loaded.rev };
}

// ---------- HyperFrames project + render ----------

function linkOrCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}
function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function buildProject(id) {
  const page = editPage(id, { mode: 'render' });
  if (!page) throw new Error(`Unknown video project: ${id}`);
  if (!page.model.main.length) throw new Error('The edit is empty: put something on the main track first.');
  const dir = path.join(EXPORTS, 'edit', id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  const theme = fs.readFileSync(path.join(PROFILE, 'theme.css'), 'utf8').replace(/url\("\/profile\/fonts\//g, 'url("fonts/');
  fs.writeFileSync(path.join(dir, 'profile', 'theme.css'), theme);
  copyDir(path.join(PROFILE, 'fonts'), path.join(dir, 'profile', 'fonts'));
  fs.copyFileSync(path.join(PROFILE, 'motion.js'), path.join(dir, 'profile', 'motion.js'));
  fs.copyFileSync(require.resolve('gsap/dist/gsap.min.js'), path.join(dir, 'gsap.min.js'));
  for (const name of page.markup.media) {
    const src = path.join(mediaDir(id), name);
    if (fs.existsSync(src)) linkOrCopy(src, path.join(dir, 'media', name));
  }
  for (const deck of page.markup.decks) {
    copyDir(path.join(DECKS, deck, 'assets'), path.join(dir, 'decks', deck, 'assets'));
    const css = path.join(DECKS, deck, 'deck.css');
    if (fs.existsSync(css)) linkOrCopy(css, path.join(dir, 'decks', deck, 'deck.css'));
  }
  for (const n of page.markup.scenes) {
    for (const ext of ['js', 'css']) {
      const f = path.join(VIDEOS, id, 'scenes', `${n}.${ext}`);
      if (fs.existsSync(f)) linkOrCopy(f, path.join(dir, 'scenes', `${n}.${ext}`));
    }
  }
  fs.writeFileSync(path.join(dir, 'index.html'), page.html);
  return { dir, fps: page.fps, duration: page.model.duration, warnings: page.model.warnings };
}

async function renderEdit(id, { quality = 'looks', onProgress } = {}) {
  const project = buildProject(id);
  const file = path.join(EXPORTS, 'videos', `${id}.mp4`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await runHyperframes(['render', project.dir, '-o', file, '-q', quality, '--fps', String(project.fps)], {
    onLine: (line) => {
      const m = line.match(/(\d{1,3})(?:\.\d+)?\s*%/);
      if (m) onProgress?.({ percent: Math.min(100, Number(m[1])) });
    },
  });
  return { file, url: `/exports/videos/${id}.mp4`, duration: project.duration };
}

module.exports = {
  VIDEOS, OVERLAY_KINDS, ANIMS, videoDir, editFile, mediaDir, loadEdit, loadMedia, listScenes, revOf, writeJSON,
  createProject, importMedia, removeMedia, uniqueName, kindOf, proxyPath, thumbPath, resolve, editPage, buildProject, renderEdit,
};
