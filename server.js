// Pitch Studio local server: serves the studio, renders slides, stores feedback,
// pushes live-reload events and exports PDFs. No framework, no build step.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DECKS = path.join(ROOT, 'decks');
const PROFILE = path.join(ROOT, 'profile');
const STUDIO = path.join(ROOT, 'studio');
const EXPORTS = path.join(ROOT, 'exports');
const PORT = Number(process.env.PORT) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};

const SLUG = /^[a-z0-9][a-z0-9-_]*$/i;

// ---------- helpers ----------

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
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

function deckDir(deck) {
  if (!SLUG.test(deck)) return null;
  const dir = path.join(DECKS, deck);
  return fs.existsSync(path.join(dir, 'deck.json')) ? dir : null;
}

function loadDeck(deck) {
  const dir = deckDir(deck);
  if (!dir) return null;
  const meta = readJSON(path.join(dir, 'deck.json'), null);
  if (!meta) return null;
  meta.id = deck;
  meta.slides = (meta.slides || []).filter((id) => SLUG.test(id));
  return meta;
}

function feedbackFile(deck) { return path.join(DECKS, deck, 'feedback.json'); }
function loadFeedback(deck) { return readJSON(feedbackFile(deck), []); }

// ---------- slide rendering ----------

// A slide file is an HTML fragment: one <section class="slide"> on a 1920x1080 canvas.
// The render page wraps it with the style profile and the deck's own overrides.
// The server also injects the deck's position (stop number + route line) so slides
// never hard-code their own number; the theme decides how, or whether, to show it.
function routeNav(index, count) {
  const stops = Array.from({ length: count }, (_, i) => `<li${i === index ? ' class="here"' : i < index ? ' class="past"' : ''}></li>`).join('');
  return `<nav class="ps-route" aria-hidden="true"><span class="ps-stop">${String(index + 1).padStart(2, '0')}</span><ol>${stops}</ol></nav>`;
}

function renderPage(deck, meta, slideIds, { print = false } = {}) {
  const dir = path.join(DECKS, deck);
  const parts = slideIds.map((id) => {
    const file = path.join(dir, 'slides', `${id}.html`);
    let html;
    try { html = fs.readFileSync(file, 'utf8'); } catch {
      html = `<section class="slide ps-missing"><p>Missing slide file: slides/${id}.html</p></section>`;
    }
    const at = html.lastIndexOf('</section>');
    const index = meta.slides.indexOf(id);
    if (at >= 0 && index >= 0) html = html.slice(0, at) + routeNav(index, meta.slides.length) + html.slice(at);
    return `<!-- slide:${id} -->\n${html}`;
  });
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

  // /render/:deck/:slide  or  /render/:deck/all
  if (parts[0] === 'render' && parts.length === 3) {
    const meta = loadDeck(parts[1]);
    if (!meta) return send(res, 404, { error: 'unknown deck' });
    const ids = parts[2] === 'all' ? meta.slides : [parts[2]].filter((id) => SLUG.test(id));
    if (!ids.length) return send(res, 404, { error: 'unknown slide' });
    return send(res, 200, renderPage(parts[1], meta, ids, { print: url.searchParams.has('print') }), MIME['.html']);
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
      ...pick(body, ['slide', 'insertAfter', 'target', 'comment', 'to', 'blocks']),
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
