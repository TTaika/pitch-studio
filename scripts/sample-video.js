// Creates videos/sample/: synthetic test footage (FFmpeg test patterns, so no real
// footage is needed), a deck clip, an animation scene and a few overlays. Used to check
// the editor and the render end to end.   node scripts/sample-video.js [--force]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const FFMPEG = require('ffmpeg-static');
const E = require('../lib/edit');

const ID = 'sample';
const dir = path.join(E.VIDEOS, ID);

(async () => {
  if (fs.existsSync(dir)) {
    if (!process.argv.includes('--force')) { console.log(`videos/${ID} exists (use --force to recreate)`); return; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  E.createProject(ID, 'Sample: footage + deck + overlays');
  const media = E.mediaDir(ID);

  // A talking-head stand-in with sound, and silent b-roll.
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8',
    '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-af', 'volume=0.08',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(media, 'talking-head.mp4')]);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:r=30', '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(media, 'b-roll.mp4')]);
  for (const name of ['talking-head.mp4', 'b-roll.mp4']) {
    await E.importMedia(ID, name);
    console.log(`imported ${name}`);
  }

  fs.writeFileSync(path.join(dir, 'scenes', 'route.html'), `<section class="anim route-scene" data-el="route">
  <h2 data-el="headline">From draft to video</h2>
  <div class="track" data-el="track"><span class="line"></span><span class="train"></span></div>
  <ol class="stops" data-el="stops">
    <li data-el="stop-write"><i></i><b>Write</b><span>Claude drafts the slides</span></li>
    <li data-el="stop-point"><i></i><b>Point</b><span>You comment and sketch</span></li>
    <li data-el="stop-render"><i></i><b>Render</b><span>Deck, PDF and MP4</span></li>
  </ol>
</section>
`);
  fs.writeFileSync(path.join(dir, 'scenes', 'route.css'), `.route-scene { padding: 140px 96px; }
.route-scene h2 { font-size: 128px; }
.route-scene .track { position: absolute; left: 240px; right: 240px; top: 560px; height: 12px; }
.route-scene .line { position: absolute; inset: 0; background: var(--sign); transform-origin: left center; }
.route-scene .train { position: absolute; top: -22px; width: 56px; height: 56px; margin-left: -28px; border-radius: 50%; background: var(--signal); }
.route-scene .stops { position: absolute; left: 240px; right: 240px; top: 532px; display: flex; justify-content: space-between; list-style: none; padding: 0; }
.route-scene .stops li { width: 0; display: flex; flex-direction: column; align-items: center; }
.route-scene .stops i { display: block; width: 68px; height: 68px; border-radius: 50%; background: var(--platform); border: 12px solid var(--sign); }
.route-scene .stops b { margin-top: 40px; font: 700 72px/1 var(--display); white-space: nowrap; }
.route-scene .stops span { margin-top: 12px; color: var(--ink-2); white-space: nowrap; }
`);
  fs.writeFileSync(path.join(dir, 'scenes', 'route.js'), `// The product's route as a line that draws itself, three stops lighting up in turn.
PitchScenes.register('route', function (tl, root, start, duration) {
  var q = function (s) { return root.querySelectorAll(s); };
  tl.fromTo(q('h2'), { x: -90, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }, start + 0.2);
  tl.fromTo(q('.line'), { scaleX: 0 }, { scaleX: 1, duration: 2.4, ease: 'none' }, start + 0.7);
  tl.fromTo(q('.train'), { left: '0%' }, { left: '100%', duration: 2.4, ease: 'none' }, start + 0.7);
  q('.stops li').forEach(function (li, i) {
    var at = start + 0.7 + i * 1.2;
    tl.fromTo(li.querySelector('i'), { scale: 0.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(2)' }, at);
    tl.fromTo(li.querySelectorAll('b, span'), { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, stagger: 0.08, ease: 'power2.out' }, at + 0.1);
  });
});
`);

  const edit = {
    title: 'Sample: footage + deck + overlays',
    fps: 30,
    main: [
      { id: 'c-intro', type: 'media', src: 'talking-head.mp4', in: 1, out: 6, volume: 1 },
      { id: 'c-deck', type: 'deck', deck: 'pitch-studio', slides: ['title', 'how'] },
      { id: 'c-route', type: 'scene', scene: 'route', duration: 5 },
      { id: 'c-broll', type: 'media', src: 'b-roll.mp4', in: 0, out: 4 },
    ],
    overlays: [
      { id: 'o-name', kind: 'lower', text: '[Your name: fill in]', sub: '[Role: fill in]', start: 0.6, duration: 3.6, anim: 'slide', box: { x: 96, y: 820, w: 760, h: 150 } },
      { id: 'o-point', kind: 'arrow', dir: 'left', text: 'Pointing at this', start: 2.2, duration: 2.6, anim: 'pop', box: { x: 1180, y: 380, w: 620, h: 120 } },
    ],
    audio: [],
  };
  // The closing title sits over the b-roll, wherever that lands after the deck.
  const model = E.resolve(ID, edit);
  const broll = model.main.find((m) => m.id === 'c-broll');
  edit.overlays.push(
    { id: 'o-close', kind: 'title', text: 'Made in Pitch Studio', sub: 'Footage, slides and motion in one cut', start: broll.start + 0.4, duration: 3.4, anim: 'rise', box: { x: 96, y: 96, w: 1100, h: 330 } },
    { id: 'o-focus', kind: 'highlight', text: 'Look here', start: broll.start + 1.2, duration: 2.6, anim: 'pop', box: { x: 1240, y: 520, w: 460, h: 340 } },
  );
  E.writeJSON(E.editFile(ID), edit);
  console.log(`videos/${ID}: ${E.resolve(ID, edit).duration}s`);
})().catch((e) => { console.error(e.message); process.exit(1); });
