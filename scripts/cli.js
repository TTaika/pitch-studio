// CLI helpers for Claude and the owner:
//   node scripts/cli.js pdf <deck>            → exports/<deck>.pdf
//   node scripts/cli.js shot <deck> [slide]   → exports/shots/<deck>-<slide>.png (all slides if omitted)
//   node scripts/cli.js video <deck> [draft]  → exports/<deck>.mp4 (HyperFrames; "draft" renders fast)
//   node scripts/cli.js video-preview <deck>  → HyperFrames preview studio for the whole video
//   node scripts/cli.js edit <video> [draft]  → exports/videos/<video>.mp4 (a video project, videos/<id>/)
//   node scripts/cli.js frames <name> <t...>  → exports/shots/<name>-frames.png, a contact sheet of
//                                               video frames at those seconds (check motion by eye)
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

// Grab frames at the given seconds and tile them 4 per row, each labelled with its time.
function frames(deck, times) {
  const { execFileSync } = require('child_process');
  const ffmpeg = require('ffmpeg-static');
  // A deck video, or a video project's (exports/videos/<id>.mp4).
  const video = [path.join(__dirname, '..', 'exports', `${deck}.mp4`), path.join(__dirname, '..', 'exports', 'videos', `${deck}.mp4`)].find((f) => fs.existsSync(f));
  if (!video) throw new Error(`No video yet: run "npm run video -- ${deck}" (deck) or "npm run edit -- ${deck}" (video project) first.`);
  const out = path.join(__dirname, '..', 'exports', 'shots', `${deck}-frames.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const cols = Math.min(4, times.length);
  const rows = Math.ceil(times.length / cols);
  const padded = [...times, ...Array(rows * cols - times.length).fill(times[times.length - 1])];
  const args = ['-v', 'error', '-y'];
  for (const t of padded) args.push('-ss', String(t), '-i', video);
  // drawtext needs a real font file; without one ffmpeg falls back noisily through fontconfig.
  const winFont = 'C:/Windows/Fonts/consola.ttf';
  const font = fs.existsSync(winFont) ? `fontfile='${winFont.replace(':', '\\:')}':` : '';
  const scaled = padded.map((t, i) => `[${i}:v]trim=end_frame=1,scale=640:-1,drawtext=${font}text='${t}s':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6[v${i}]`);
  const rowsF = Array.from({ length: rows }, (_, r) => `${padded.slice(r * cols, r * cols + cols).map((_, c) => `[v${r * cols + c}]`).join('')}hstack=${cols}[r${r}]`);
  const stack = rows > 1 ? `;${Array.from({ length: rows }, (_, r) => `[r${r}]`).join('')}vstack=${rows}[out]` : '';
  args.push('-filter_complex', [...scaled, ...rowsF].join(';') + stack, '-map', rows > 1 ? '[out]' : '[r0]', '-frames:v', '1', out);
  execFileSync(ffmpeg, args);
  return out;
}

(async () => {
  const [cmd, deck, slide] = process.argv.slice(2);
  if (!['pdf', 'shot', 'video', 'video-preview', 'frames', 'edit'].includes(cmd) || !deck) {
    console.log('Usage: node scripts/cli.js pdf <deck> | shot <deck> [slide] | video <deck> [draft] | video-preview <deck> | frames <deck|video> <seconds...> | edit <video> [draft]');
    process.exit(1);
  }
  if (cmd === 'frames') {
    const times = process.argv.slice(4).map(Number).filter((t) => t >= 0);
    if (!times.length) throw new Error('Give one or more times in seconds, e.g. frames pitch-studio 0.5 3 7.2');
    console.log(frames(deck, times));
    return;
  }
  // Video commands don't need the studio server.
  if (cmd === 'video') {
    const { renderVideo } = require('../lib/video');
    let last = -1;
    const r = await renderVideo(deck, {
      quality: slide === 'draft' ? 'draft' : 'looks',
      onProgress: ({ percent }) => { if (percent >= last + 10 || percent === 100) { last = percent; console.log(`${percent}%`); } },
    });
    console.log(`${r.file} (${r.duration}s, ${r.scenes} scenes)`);
    return;
  }
  if (cmd === 'edit') {
    const { renderEdit } = require('../lib/edit');
    let last = -1;
    const r = await renderEdit(deck, {
      quality: slide === 'draft' ? 'draft' : 'looks',
      onProgress: ({ percent }) => { if (percent >= last + 10 || percent === 100) { last = percent; console.log(`${percent}%`); } },
    });
    console.log(`${r.file} (${r.duration}s)`);
    return;
  }
  if (cmd === 'video-preview') {
    const { buildProject, runHyperframes } = require('../lib/video');
    const project = buildProject(deck);
    console.log(`Project: ${project.dir}`);
    await runHyperframes(['preview', project.dir], { onLine: (l) => console.log(l) });
    return;
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
