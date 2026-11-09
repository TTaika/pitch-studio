// Pitch Studio local server: serves the studio, renders slides, stores feedback,
// pushes live-reload events and exports PDFs and videos. No framework, no build step.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, DECKS, SLUG, readJSON, deckDir, loadDeck, slideFragment, sceneDuration } = require('./lib/deck');

const PROFILE = path.join(ROOT, 'profile');
const STUDIO = path.join(ROOT, 'studio');
const EXPORTS = path.join(ROOT, 'exports');
const PORT = Number(process.env.PORT) || 4173;
const GSAP = require.resolve('gsap/dist/gsap.min.js');
const E = require('./lib/edit');
const VIDEOS = E.VIDEOS;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};

// ---------- helpers ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Resolve a URL path under a base dir, refusing anything that escapes it.
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, decodeURIComponent(rel)));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// Media is streamed with Range support: a <video> can only seek when the server answers 206.
function serveMedia(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = Math.min(m[1] && m[2] ? Number(m[2]) : st.size - 1, st.size - 1);
    if (start >= st.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}

// Feedback lives next to what it is about: decks/<id>/ or videos/<id>/.
function feedbackFile(deck) { return path.join(DECKS, deck, 'feedback.json'); }

async function handleFeedback(req, res, file, id) {
  const method = req.method;
  const items = readJSON(file, []);
  if (!id && method === 'GET') return send(res, 200, items);

  if (!id && method === 'POST') {
    const body = await readBody(req);
    const item = {
      id: `fb-${crypto.randomBytes(3).toString('hex')}`,
      type: body.type,
      status: 'open',
      createdAt: new Date().toISOString(),
      ...pick(body, ['slide', 'insertAfter', 'clip', 'target', 'comment', 'to', 'blocks', 'time', 'until']),
    };
    if (!['comment', 'adjust', 'layout'].includes(item.type)) return send(res, 400, { error: 'bad type' });
    items.push(item);
    writeJSON(file, items);
    return send(res, 201, item);
  }

  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return send(res, 404, { error: 'unknown feedback item' });

  if (method === 'PATCH') {
    const body = await readBody(req);
    Object.assign(items[idx], pick(body, ['comment', 'to', 'blocks', 'status', 'target', 'time', 'until']), { updatedAt: new Date().toISOString() });
    writeJSON(file, items);
    return send(res, 200, items[idx]);
  }
  if (method === 'DELETE') {
    const [removed] = items.splice(idx, 1);
    writeJSON(file, items);
    return send(res, 200, removed);
  }
  return send(res, 405, { error: 'method not allowed' });
}

// ---------- slide rendering ----------

// The render page wraps slide fragments with the style profile and the deck's own
// overrides. With motion, a single slide also gets its scene timeline from
// profile/motion.js, exposed as window.__ps so the studio can play and scrub it.
function renderPage(deck, meta, slideIds, { print = false, motion = false } = {}) {
  const dir = path.join(DECKS, deck);
  const parts = slideIds.map((id) => `<!-- slide:${id} -->\n${slideFragment(meta, id)}`);
  const motionScript = motion && slideIds.length === 1 ? `
<script src="/vendor/gsap.min.js"></script>
<script src="/profile/motion.js"></script>
<script>
  (() => {
    const duration = ${sceneDuration(meta, slideIds[0], parts[0])};
    const tl = gsap.timeline({ paused: true });
    const scene = PitchMotion.build(tl, document.querySelector('section.slide'), 0, duration, { exit: true });
    window.__ps = { duration, rest: scene.rest, seek: (t) => tl.seek(Math.max(0, Math.min(duration, t)), false) };
    window.__ps.seek(scene.rest);
  })();
</script>` : '';
  const deckCss = fs.existsSync(path.join(dir, 'deck.css')) ? `<link rel="stylesheet" href="/decks/${deck}/deck.css">` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<base href="/decks/${deck}/">
<link rel="stylesheet" href="/profile/theme.css">
${deckCss}
<style>
  html,body{margin:0;padding:0}
  body{width:1920px;${print ? '' : 'height:1080px;overflow:hidden;'}}
  .ps-missing{display:grid;place-items:center;font:600 40px system-ui;color:#b00}
  ${print ? '@page{size:1920px 1080px;margin:0} .slide{break-after:page}' : ''}
</style>
</head><body class="ps-render${print ? ' ps-print' : ''}">
${parts.join('\n')}
${motionScript}
</body></html>`;
}

// ---------- live reload (server-sent events) ----------

const clients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

let pending = new Map();
function watch(dir, scope, onChange) {
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, { recursive: true }, (_type, name) => {
    if (!name || name.endsWith('.tmp')) return;
    const rel = name.split(path.sep).join('/');
    // Generated previews are not edits.
    if (/\/media\/\.(proxy|thumbs)\//.test(rel)) return;
    // Debounce: editors and Claude often write a file in several steps.
    const key = `${scope}:${rel}`;
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      broadcast({ type: 'change', scope, path: rel });
      onChange?.(rel);
    }, 120));
  });
}

// ---------- video projects: media import + render ----------

// Files being uploaded or imported right now, "<video>/<name>", so the watcher
// doesn't import a half-written upload a second time.
const importing = new Set();

function startImport(video, name) {
  const key = `${video}/${name}`;
  importing.add(key);
  return E.importMedia(video, name, { onStatus: (s) => broadcast({ type: 'media', video, ...s }) })
    .catch((e) => console.error(`import ${key}: ${e.message}`))
    .finally(() => importing.delete(key));
}

// A file dropped into videos/<id>/media/ by hand (Explorer, or Claude saving a generated
// image) is imported like an upload once its size stops changing.
function autoImport(rel) {
  const m = /^([^/]+)\/media\/([^/.][^/]*)$/.exec(rel);
  if (!m || !E.videoDir(m[1]) || importing.has(`${m[1]}/${m[2]}`)) return;
  const [, video, name] = m;
  const file = path.join(VIDEOS, video, 'media', name);
  if (!E.kindOf(name) || E.loadMedia(video)[name]) return;
  let last = -1;
  const check = () => fs.stat(file, (err, st) => {
    if (err || importing.has(`${video}/${name}`)) return;
    if (st.size === last) startImport(video, name); else { last = st.size; setTimeout(check, 1000); }
  });
  check();
}

const renderJobs = new Map();
function startRender(video, quality) {
  const job = { state: 'running', percent: 0 };
  renderJobs.set(video, job);
  broadcast({ type: 'render', video, ...job });
  let last = -1;
  E.renderEdit(video, {
    quality,
    onProgress: ({ percent }) => {
      if (percent === last) return;
      last = job.percent = percent;
      broadcast({ type: 'render', video, ...job });
    },
  }).then((r) => {
    broadcast({ type: 'render', video, state: 'done', url: r.url, duration: r.duration });
  }).catch((e) => {
    console.error(e.message);
    broadcast({ type: 'render', video, state: 'error', message: e.message.split('\n')[0] });
  }).finally(() => renderJobs.delete(video));
}

// Everything the editor needs in one response. Slide HTML stays on the server.
function videoState(id) {
  const loaded = E.loadEdit(id);
  const media = E.loadMedia(id);
  const model = E.resolve(id, loaded.edit, media);
  model.main = model.main.map(({ slides, ...item }) => (slides ? { ...item, slides: slides.map(({ html, ...s }) => s) } : item));
  return { id, rev: loaded.rev, edit: loaded.edit, media, scenes: E.listScenes(id), model, render: renderJobs.get(id) || null };
}

// ---------- PDF export ----------

async function exportPdf(deck) {
  const meta = loadDeck(deck);
  const { chromium } = require('playwright-core');
  let browser;
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* try next */ }
  }
  if (!browser) throw new Error('No Edge or Chrome found for PDF export.');
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`http://127.0.0.1:${PORT}/render/${deck}/all?print=1`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(EXPORTS, { recursive: true });
    const file = path.join(EXPORTS, `${deck}.pdf`);
    await page.pdf({ path: file, width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
    return { file, url: `/exports/${deck}.pdf`, slides: meta.slides.length };
  } finally {
    await browser.close();
  }
}

// ---------- video export ----------

const videoJobs = new Map();
function startVideo(deck) {
  const job = { state: 'running', percent: 0 };
  videoJobs.set(deck, job);
  broadcast({ type: 'video', deck, ...job });
  let last = -1;
  require('./lib/video').renderVideo(deck, {
    onProgress: ({ percent }) => {
      if (percent === last) return;
      last = job.percent = percent;
      broadcast({ type: 'video', deck, ...job });
    },
  }).then((r) => {
    broadcast({ type: 'video', deck, state: 'done', url: r.url, duration: r.duration });
  }).catch((e) => {
    console.error(e.message);
    broadcast({ type: 'video', deck, state: 'error', message: e.message.split('\n')[0] });
  }).finally(() => videoJobs.delete(deck));
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (url.pathname === '/') return serveFile(res, path.join(STUDIO, 'index.html'));

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('data: {"type":"hello"}\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (parts[0] === 'studio') {
    const f = safeJoin(STUDIO, parts.slice(1).join('/'));
    return f ? serveFile(res, f) : send(res, 403, { error: 'forbidden' });
  }
  if (parts[0] === 'profile') {
    const f = safeJoin(PROFILE, parts.slice(1).join('/'));
    return f ? serveFile(res, f) : send(res, 403, { error: 'forbidden' });
  }
  if (parts[0] === 'exports') {
    const f = safeJoin(EXPORTS, parts.slice(1).join('/'));
    if (!f) return send(res, 403, { error: 'forbidden' });
    return f.endsWith('.mp4') ? serveMedia(req, res, f) : serveFile(res, f);
  }
  if (url.pathname === '/edit') return serveFile(res, path.join(STUDIO, 'editor.html'));
  if (parts[0] === 'videos' && method === 'GET') {
    const f = safeJoin(VIDEOS, parts.slice(1).join('/'));
    if (!f) return send(res, 403, { error: 'forbidden' });
    return /\.(html|css|js|json|svg)$/i.test(f) ? serveFile(res, f) : serveMedia(req, res, f);
  }
  // /render-edit/:video → the edit as one page (proxies), driven by studio/edit-runtime.js
  if (parts[0] === 'render-edit' && parts.length === 2) {
    if (!E.videoDir(parts[1])) return send(res, 404, { error: 'unknown video project' });
    return send(res, 200, E.editPage(parts[1], { mode: 'preview' }).html, MIME['.html']);
  }
  if (parts[0] === 'decks' && method === 'GET') {
    const f = safeJoin(DECKS, parts.slice(1).join('/'));
    return f ? serveFile(res, f) : send(res, 403, { error: 'forbidden' });
  }
  if (url.pathname === '/vendor/gsap.min.js') return serveFile(res, GSAP);

  // /render/:deck/:slide  or  /render/:deck/all
  if (parts[0] === 'render' && parts.length === 3) {
    const meta = loadDeck(parts[1]);
    if (!meta) return send(res, 404, { error: 'unknown deck' });
    const ids = parts[2] === 'all' ? meta.slides : [parts[2]].filter((id) => SLUG.test(id));
    if (!ids.length) return send(res, 404, { error: 'unknown slide' });
    const opts = { print: url.searchParams.has('print'), motion: url.searchParams.has('motion') };
    return send(res, 200, renderPage(parts[1], meta, ids, opts), MIME['.html']);
  }

  if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
  if (parts[1] === 'videos') return handleVideos(req, res, url, parts);

  // GET /api/decks
  if (parts[1] === 'decks' && parts.length === 2 && method === 'GET') {
    const list = fs.existsSync(DECKS) ? fs.readdirSync(DECKS).map(loadDeck).filter(Boolean) : [];
    return send(res, 200, list.map(({ id, title, slides }) => ({ id, title, slides: slides.length })));
  }

  const deck = parts[2];
  if (parts[1] !== 'decks' || !deck || !deckDir(deck)) return send(res, 404, { error: 'unknown deck' });

  // GET /api/decks/:deck
  if (parts.length === 3 && method === 'GET') return send(res, 200, loadDeck(deck));

  // POST /api/decks/:deck/export
  if (parts[3] === 'export' && method === 'POST') {
    try { return send(res, 200, await exportPdf(deck)); } catch (e) { return send(res, 500, { error: e.message }); }
  }

  // POST /api/decks/:deck/video → starts a render; progress arrives as SSE "video" events.
  if (parts[3] === 'video' && method === 'POST') {
    if (videoJobs.has(deck)) return send(res, 409, { error: 'A video render is already running for this deck.' });
    startVideo(deck);
    return send(res, 202, { state: 'running' });
  }
  if (parts[3] === 'video' && method === 'GET') return send(res, 200, videoJobs.get(deck) || { state: 'idle' });

  if (parts[3] !== 'feedback') return send(res, 404, { error: 'not found' });
  return handleFeedback(req, res, feedbackFile(deck), parts[4]);
}

// /api/videos/...
async function handleVideos(req, res, url, parts) {
  const method = req.method;
  if (parts.length === 2 && method === 'GET') {
    const ids = fs.existsSync(VIDEOS) ? fs.readdirSync(VIDEOS).filter((d) => E.videoDir(d)) : [];
    return send(res, 200, ids.map((id) => {
      try { const { edit } = E.loadEdit(id); return { id, title: edit.title || id, duration: E.resolve(id, edit).duration }; } catch (e) { return { id, title: id, error: e.message }; }
    }));
  }
  if (parts.length === 2 && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || body.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    try { E.createProject(id, body.title); } catch (e) { return send(res, 400, { error: e.message }); }
    return send(res, 201, videoState(id));
  }

  const id = parts[2];
  if (!E.videoDir(id)) return send(res, 404, { error: 'unknown video project' });

  if (parts.length === 3 && method === 'GET') return send(res, 200, videoState(id));

  // PUT /api/videos/:id  { edit, rev } → saved only if nobody (Claude) changed it meanwhile.
  if (parts.length === 3 && method === 'PUT') {
    const body = await readBody(req);
    const current = E.loadEdit(id);
    if (body.rev && body.rev !== current.rev) return send(res, 409, { error: 'edit.json changed on disk', ...videoState(id) });
    if (!body.edit || !Array.isArray(body.edit.main)) return send(res, 400, { error: 'edit.main must be an array' });
    E.writeJSON(E.editFile(id), body.edit);
    return send(res, 200, videoState(id));
  }

  // POST /api/videos/:id/media?name=clip.mov   (raw file body, streamed to disk)
  if (parts[3] === 'media' && parts.length === 4 && method === 'POST') {
    const original = url.searchParams.get('name') || 'clip';
    if (!E.kindOf(original)) return send(res, 400, { error: `Not a video, audio or image file: ${original}` });
    const dir = E.mediaDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const name = E.uniqueName(dir, original);
    const key = `${id}/${name}`;
    importing.add(key);
    const file = path.join(dir, name);
    const out = fs.createWriteStream(file);
    req.pipe(out);
    out.on('finish', () => {
      startImport(id, name);
      send(res, 202, { name, status: 'processing' });
    });
    const fail = (e) => { importing.delete(key); fs.rm(file, { force: true }, () => {}); if (!res.headersSent) send(res, 500, { error: e.message }); };
    out.on('error', fail);
    req.on('error', fail);
    return;
  }
  // DELETE /api/videos/:id/media/:name  (only when nothing in the edit uses it)
  if (parts[3] === 'media' && parts[4] && method === 'DELETE') {
    const name = decodeURIComponent(parts[4]);
    const { edit } = E.loadEdit(id);
    const users = [...edit.main, ...edit.overlays, ...edit.audio].filter((c) => c.src === name).map((c) => c.id);
    if (users.length) return send(res, 409, { error: `Still used by ${users.join(', ')}` });
    const f = safeJoin(E.mediaDir(id), name);
    if (!f) return send(res, 403, { error: 'forbidden' });
    for (const p of [f, E.proxyPath(E.mediaDir(id), name), E.thumbPath(E.mediaDir(id), name)]) fs.rmSync(p, { force: true });
    await E.removeMedia(id, name);
    return send(res, 200, { name });
  }

  if (parts[3] === 'render' && method === 'POST') {
    if (renderJobs.has(id)) return send(res, 409, { error: 'A render is already running for this video.' });
    const body = await readBody(req);
    startRender(id, body.quality === 'draft' ? 'draft' : 'looks');
    return send(res, 202, { state: 'running' });
  }
  if (parts[3] === 'render' && method === 'GET') return send(res, 200, renderJobs.get(id) || { state: 'idle' });

  if (parts[3] === 'feedback') return handleFeedback(req, res, path.join(VIDEOS, id, 'feedback.json'), parts[4]);
  return send(res, 404, { error: 'not found' });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function start() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: e.message }));
  });
  watch(DECKS, 'decks');
  watch(PROFILE, 'profile');
  watch(STUDIO, 'studio');
  fs.mkdirSync(VIDEOS, { recursive: true });
  watch(VIDEOS, 'videos', autoImport);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Pitch Studio running at http://127.0.0.1:${PORT}/`);
      resolve(server);
    });
  });
}

module.exports = { start, exportPdf, PORT };

if (require.main === module) {
  start().catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use; is the studio already running?` : e);
    process.exit(1);
  });
}
