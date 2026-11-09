// CLI helpers for Claude and the owner:
//   node scripts/cli.js pdf <deck>            → exports/<deck>.pdf
//   node scripts/cli.js shot <deck> [slide]   → exports/shots/<deck>-<slide>.png (all slides if omitted)
// Reuses a running studio server, or starts one for the duration of the command.
const fs = require('fs');
const path = require('path');
const { start, exportPdf, PORT } = require('../server.js');

const BASE = `http://127.0.0.1:${PORT}`;

async function ensureServer() {
  try { await fetch(`${BASE}/api/decks`); return null; } catch { return start(); }
}

async function shot(deck, slide) {
  const meta = await (await fetch(`${BASE}/api/decks/${deck}`)).json();
  if (meta.error) throw new Error(meta.error);
  const ids = slide ? [slide] : meta.slides;
  const { chromium } = require('playwright-core');
  let browser;
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel }); break; } catch { /* try next */ }
  }
  if (!browser) throw new Error('No Edge or Chrome found.');
  const out = path.join(__dirname, '..', 'exports', 'shots');
  fs.mkdirSync(out, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    for (const id of ids) {
      await page.goto(`${BASE}/render/${deck}/${id}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(out, `${deck}-${id}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  const [cmd, deck, slide] = process.argv.slice(2);
  if (!['pdf', 'shot'].includes(cmd) || !deck) {
    console.log('Usage: node scripts/cli.js pdf <deck> | shot <deck> [slide]');
    process.exit(1);
  }
  const server = await ensureServer();
  try {
    if (cmd === 'pdf') console.log((await exportPdf(deck)).file);
    else await shot(deck, slide);
  } finally {
    server?.close();
    process.exit(process.exitCode || 0);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
