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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
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

function feedbackFile(deck) { return path.join(DECKS, deck, 'feedback.json'); }
function loadFeedback(deck) { return readJSON(feedbackFile(deck), []); }

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
function watch(dir, scope) {
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, { recursive: true }, (_type, name) => {
    if (!name || name.endsWith('.tmp')) return;
    const rel = name.split(path.sep).join('/');
    // Debounce: editors and Claude often write a file in several steps.
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(() => {
      pending.delete(rel);
      broadcast({ type: 'change', scope, path: rel });
    }, 120));
  });
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
    return f ? serveFile(res, f) : send(res, 403, { error: 'forbidden' });
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
  const items = loadFeedback(deck);
  const id = parts[4];

  if (!id && method === 'GET') return send(res, 200, items);

  if (!id && method === 'POST') {
    const body = await readBody(req);
    const item = {
      id: `fb-${crypto.randomBytes(3).toString('hex')}`,
      type: body.type,
      status: 'open',
      createdAt: new Date().toISOString(),
      ...pick(body, ['slide', 'insertAfter', 'target', 'comment', 'to', 'blocks', 'time']),
    };
    if (!['comment', 'adjust', 'layout'].includes(item.type)) return send(res, 400, { error: 'bad type' });
    items.push(item);
    writeJSON(feedbackFile(deck), items);
    return send(res, 201, item);
  }

  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return send(res, 404, { error: 'unknown feedback item' });

  if (method === 'PATCH') {
    const body = await readBody(req);
    Object.assign(items[idx], pick(body, ['comment', 'to', 'blocks', 'status', 'target']), { updatedAt: new Date().toISOString() });
    writeJSON(feedbackFile(deck), items);
    return send(res, 200, items[idx]);
  }
  if (method === 'DELETE') {
    const [removed] = items.splice(idx, 1);
    writeJSON(feedbackFile(deck), items);
    return send(res, 200, removed);
  }
  return send(res, 405, { error: 'method not allowed' });
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
