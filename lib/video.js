// Deck → HyperFrames project → MP4. The project mirrors the studio's render page:
// same slide fragments, same theme, same motion grammar (profile/motion.js), so the
// video is the studio preview played end to end.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, DECKS, loadDeck, slideFragment, sceneDuration } = require('./deck');

const PROFILE = path.join(ROOT, 'profile');
const EXPORTS = path.join(ROOT, 'exports');
const HYPERFRAMES = path.join(path.dirname(require.resolve('hyperframes/package.json')), 'bin', 'hyperframes.mjs');

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst); else fs.copyFileSync(src, dst);
  }
}

// Writes exports/video/<deck>/ and returns its scene list.
function buildProject(deck) {
  const meta = loadDeck(deck);
  if (!meta) throw new Error(`Unknown deck: ${deck}`);
  if (!meta.slides.length) throw new Error('The deck has no slides.');
  const dir = path.join(EXPORTS, 'video', deck);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });

  // The theme uses absolute /profile/fonts URLs for the studio; the project serves
  // from its own root, so point them at the copied fonts instead.
  const theme = fs.readFileSync(path.join(PROFILE, 'theme.css'), 'utf8').replace(/url\("\/profile\/fonts\//g, 'url("fonts/');
  fs.writeFileSync(path.join(dir, 'profile', 'theme.css'), theme);
  copyDir(path.join(PROFILE, 'fonts'), path.join(dir, 'profile', 'fonts'));
  fs.copyFileSync(path.join(PROFILE, 'motion.js'), path.join(dir, 'profile', 'motion.js'));
  fs.copyFileSync(require.resolve('gsap/dist/gsap.min.js'), path.join(dir, 'gsap.min.js'));
  copyDir(path.join(DECKS, deck, 'assets'), path.join(dir, 'assets'));
  const deckCss = path.join(DECKS, deck, 'deck.css');
  if (fs.existsSync(deckCss)) fs.copyFileSync(deckCss, path.join(dir, 'deck.css'));

  let t = 0;
  const scenes = meta.slides.map((id, i) => {
    const html = slideFragment(meta, id);
    const duration = sceneDuration(meta, id, html);
    const scene = { id, start: Math.round(t * 100) / 100, duration, html, last: i === meta.slides.length - 1 };
    t += duration;
    return scene;
  });
  const fps = meta.video?.fps || 30;

  const clips = scenes.map((s, i) => `  <div class="clip scene" id="scene-${s.id}" data-start="${s.start}" data-duration="${s.duration}" data-track-index="0" style="z-index:${i + 1}">
${s.html}
  </div>`).join('\n');

  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${(meta.title || deck).replace(/</g, '&lt;')}</title>
<link rel="stylesheet" href="profile/theme.css">
${fs.existsSync(deckCss) ? '<link rel="stylesheet" href="deck.css">' : ''}
<style>
  html, body { margin: 0; background: #000; }
  /* Between scenes the viewer sees the platform, not a black gap. */
  #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: var(--platform, #e4e7e9); }
  .scene { position: absolute; inset: 0; }
</style>
</head><body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-fps="${fps}">
${clips}
</div>
<script src="gsap.min.js"></script>
<script src="profile/motion.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  ${JSON.stringify(scenes.map(({ id, start, duration, last }) => ({ id, start, duration, last })))}.forEach((s) => {
    PitchMotion.build(tl, document.querySelector('#scene-' + s.id + ' section.slide'), s.start, s.duration, { exit: !s.last });
  });
  window.__timelines = window.__timelines || {};
  window.__timelines.root = tl;
</script>
</body></html>
`);
  return { dir, fps, duration: Math.round(t * 100) / 100, scenes: scenes.map(({ id, start, duration }) => ({ id, start, duration })) };
}

// FFmpeg/ffprobe come from npm packages, put on PATH only for this child process.
function hyperframesEnv() {
  const ffmpegDir = path.dirname(require('ffmpeg-static'));
  const ffprobeDir = path.dirname(require('@ffprobe-installer/ffprobe').path);
  return { ...process.env, PATH: [ffmpegDir, ffprobeDir, process.env.PATH].join(path.delimiter), HYPERFRAMES_NO_TELEMETRY: '1' };
}

function runHyperframes(args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HYPERFRAMES, ...args], { cwd, env: hyperframesEnv(), windowsHide: true });
    let tail = '';
    const onData = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n|\r/)) if (line.trim()) onLine?.(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(`hyperframes ${args[0]} failed (exit ${code}):\n${tail.trim().split('\n').slice(-12).join('\n')}`))));
  });
}

// Build + render. onProgress receives { percent } while frames are captured/encoded.
async function renderVideo(deck, { quality = 'looks', onProgress } = {}) {
  const project = buildProject(deck);
  const file = path.join(EXPORTS, `${deck}.mp4`);
  await runHyperframes(['render', project.dir, '-o', file, '-q', quality, '--fps', String(project.fps)], {
    onLine: (line) => {
      const m = line.match(/(\d{1,3})(?:\.\d+)?\s*%/);
      if (m) onProgress?.({ percent: Math.min(100, Number(m[1])) });
    },
  });
  return { file, url: `/exports/${deck}.mp4`, duration: project.duration, scenes: project.scenes.length };
}

module.exports = { buildProject, renderVideo, runHyperframes };
