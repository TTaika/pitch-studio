# Pitch Studio

Local tool for making personal pitch decks and videos. Claude writes slides as HTML; the owner reviews them in the studio and points at what to change; Claude applies that feedback and records the taste it learns. The video editor does the same for the owner's own footage.

Run: `npm start` → http://127.0.0.1:4173/ (`?deck=<id>` picks a deck), video editor at `/edit`. Both live-reload whenever a slide, theme, edit or feedback file changes.

## Layout

```
profile/style.md     The style profile: voice, layout grammar, bans, learned rules. READ BEFORE WRITING ANY SLIDE.
profile/theme.css    Design tokens + slide layout classes shared by every deck.
decks/<id>/deck.json { "title": "...", "slides": ["title", "problem", ...] }   ← order lives here
decks/<id>/slides/<slide>.html   One <section class="slide"> fragment, 1920×1080 canvas.
decks/<id>/deck.css  Optional per-deck overrides (keep tiny; taste belongs in the profile).
decks/<id>/assets/   Images for the deck (reference as assets/x.png; the render page has <base href="/decks/<id>/">).
decks/<id>/feedback.json  Written by the studio. You read it and mark items done.
videos/<id>/          Video projects (see Video projects below).
studio/              The studio + video editor UI (vanilla JS). server.js serves everything; lib/ holds deck, video and edit logic.
exports/             PDF, MP4 and screenshot output (gitignored).
```

## Writing slides

- A slide file is a fragment, not a document: exactly one `<section class="slide" data-layout="...">`. No `<html>`, no `<style>` blocks, no inline `style=""` positioning. Use the layout classes and tokens in `profile/theme.css`; extend the theme if something is missing.
- **Every meaningful element gets a `data-el="<name>"`** (headline, sub, stat-1, logo, photo, ...). Names are unique per slide and stay stable across edits. The studio uses them to find what the owner pointed at; feedback targets them as `[data-el="headline"]`.
- Follow `profile/style.md` to the letter, including its **Learned rules**. They are corrections the owner already gave once.
- Never invent facts: no fake customers, metrics, testimonials, prices. If a slide needs a number you don't have, write a visible placeholder like `[ARR — fill in]`.

## Applying feedback

When asked to apply feedback (usually via the `/apply-feedback <deck>` slash command, which the studio's "Copy prompt for Claude" button copies):

1. Read `decks/<id>/feedback.json` and handle every item with `"status": "open"`.
2. Item types (all coordinates are canvas pixels on the 1920×1080 slide):
   - `comment`: `target.selector` / `target.el` names the element, `target.text` is what it said, `comment` is the instruction. If `target.selector` is `section.slide`, it's about the whole slide. If the item has a `time` (seconds into that slide's scene), the owner paused the motion there: the comment is about **how it moves at that moment** (see Motion below), not about the settled layout.
   - `adjust`: the owner dragged/resized the element from `target.rect` to `to`. Rebuild the slide so the element lands there **through the layout system** (grid columns, theme spacing, sizes): never paste absolute `left/top` pixels. Match within ~2% of the canvas; if the theme grid can't express it, say so in the resolution. `comment` may explain why.
   - `layout`: `blocks` is a sketch: labelled rectangles saying what goes where. With `slide` set, restructure that slide to match. With `slide: null`, create a **new slide** at `insertAfter` (null = first): add the slide file and insert its id into `deck.json`.
3. Edit the slide files. Then update each handled item in `feedback.json`: set `"status": "done"` and add `"resolution": "<one short sentence on what changed>"`. If you deliberately did not do something, use `"status": "wontfix"` and say why. Keep every other field as is. Edit the JSON carefully: the studio is writing to it too, so re-read it right before you write it.
4. **Learn.** If a comment expresses taste that would apply beyond this one element ("too corporate", "never centre text", "numbers need units"), add it as a one-line rule under **Learned rules** in `profile/style.md` (with the date). Don't add one-off content fixes. Tell the owner which rules you added.
5. Verify by screenshot before reporting: `npm run shot -- <deck> <slide>` writes `exports/shots/<deck>-<slide>.png`; look at it. For timed (motion) feedback, render a draft video and check frames around that moment with `npm run frames`.

## Motion

Every slide is also a video scene. `profile/motion.js` is the motion grammar (part of the style profile): it builds each slide in a fixed order (sign panel → stop roundel → headline → content → orange focus last), then pulls the slide out to the left. The studio's play/scrub bar and the MP4 run the same code, so they always agree.

Levers, from most local to most global:
- On an element: `data-build="none"` (don't animate), `data-build="focus"` (enters last, as the focus), `data-build-at="1.6"` (start its entrance at 1.6s into the scene).
- In `deck.json`: `"video": { "fps": 30, "durations": { "<slide-id>": 6 } }` sets scene lengths in seconds. Default is about 4 words a second plus build time, clamped to 4–8s.
- In `profile/motion.js`: change the grammar itself (timings, distances, easing) only when the owner's feedback is about motion in general ("everything is too slow"). That is taste, so also add a Learned rule.

Rules: animate only with seekable GSAP tweens on the timeline the grammar builds (no CSS animations, timers, `Math.random`, autoplay media or external fonts/CDNs); the renderer seeks frame by frame.

## Video projects

The owner's own footage, cut together with deck scenes, animations and overlays. Editor: http://127.0.0.1:4173/edit (`?v=<id>`). Same loop as decks: they cut and point in the editor, you apply feedback with `/apply-feedback video <id>`.

```
videos/<id>/edit.json     The edit. You and the editor both write it; re-read before writing.
videos/<id>/media.json    Server-owned index of imported files (kind, duration, size, hasAudio). Read only.
videos/<id>/media/        Original files (+ .proxy/ and .thumbs/, generated). Save a generated image here and it is imported automatically.
videos/<id>/scenes/       Animation scenes you write: <name>.html (+ <name>.css, <name>.js).
videos/<id>/feedback.json Comments and sketches, each with a time on the video's timeline.
```

`edit.json`:

```json
{ "title": "Launch video", "fps": 30,
  "main": [                                         // plays back to back
    { "id": "c-intro", "type": "media", "src": "intro.mov", "in": 1.2, "out": 6, "volume": 1 },
    { "id": "c-logo",  "type": "media", "src": "logo.png", "duration": 3 },
    { "id": "c-deck",  "type": "deck", "deck": "pitch-studio", "slides": ["title", "how"], "durations": { "how": 5 },
      "transition": { "kind": "crossfade", "duration": 0.6 } },  // into this clip from the one before
    { "id": "c-anim",  "type": "scene", "scene": "app-steps", "duration": 6, "prompt": "the app's three steps" } ],
  "overlays": [                                     // on top of the picture, absolute times
    { "id": "o-name", "kind": "lower", "text": "Name", "sub": "Role", "start": 0.6, "duration": 3.5,
      "anim": "slide", "box": { "x": 96, "y": 820, "w": 760, "h": 150 } } ],
  "audio": [ { "id": "a-music", "src": "music.mp3", "start": 0, "in": 0, "volume": 0.6 } ] }
```

- Overlay kinds: `title` (text, sub), `lower` (text, sub), `label` (text), `arrow` (text, `dir`: left|right|up|down|up-right), `highlight` (text: the tag under the frame), `image` (`src` from media), `anim` (`scene`). `anim`: rise|slide|fade|pop|wipe|none. `box` is canvas pixels on 1920×1080: for overlays the box IS the position (data, not a layout instruction), so set it directly.
- Media `in`/`out` are seconds inside the source file; times elsewhere are seconds on the video. Deck clips reuse the deck's slides and motion untouched; `slides` picks a subset, `durations` retimes them for this video only.
- Overlays use the Platform Signage look from `profile/theme.css` (`.ov-*`). Orange only for what's being pointed at (arrow, highlight), one at a time. If an overlay style is missing, extend the theme, don't inline styles.
- Never invent facts in overlays either: placeholders like `[Name: fill in]`.
- **Transitions**: `transition` on a main item is the transition *into* it from the previous item (ignored on the first). `kind`: `cut` (or no field) | `crossfade` | `dip` (`color`: black|white|sign|signal) | `wipe` / `push` (`dir`: left|right|up|down, the way the motion travels) | `route` (the orange route line sweeps across, `dir`: left|right). `duration` in seconds (default 0.6), capped at half of either clip. The two clips overlap by that much, so **every transition makes the video that much shorter** and moves every later clip earlier: re-check overlay times after adding one. Footage sound crossfades over the overlap. Motion lives in `PitchMotion.transition` (`profile/motion.js`), the route line's look in `profile/theme.css` (`.tx-route`). Cuts are taste: a few kinds per video, each with a reason; most seams stay straight cuts.

**Animation requests**: the owner presses **+ Animation** on the main track (or on a cut) and describes one. The editor adds a placeholder `scene` clip with a `prompt` and a free scene name (it shows "Animation on its way" until the file exists) and an `animation` feedback item (`clip` = that clip, `comment` = the prompt, `target.scene` = the name). Write `scenes/<that name>.*` for the clip's full 1920×1080 frame and its `duration`; leave the `prompt` field in place.

**Animation scenes** ("make an animation of the product doing X"): `scenes/<name>.html` is one `<section class="anim" data-el="...">` filling its clip (1920×1080 on the main track, or the overlay's box), every meaningful element with a `data-el`. Style it in `scenes/<name>.css` with theme tokens (scope selectors under a scene class). Animate in `scenes/<name>.js`:

```js
PitchScenes.register('app-steps', function (tl, root, start, duration) {
  tl.fromTo(root.querySelector('[data-el="headline"]'), { x: -90, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }, start + 0.2);
});
```

Same motion rules as slides: only seekable GSAP tweens on `tl` at absolute times (`start + …`), **`fromTo` not `from`**, no timers, CSS animations, randomness or external URLs. Use the owner's real product screenshots from `media/` when they exist; never draw fake UI with invented data. A scene without a `.js` falls back to the slide grammar. `videos/sample/` (`npm run sample-video`) has a working example (`scenes/route.*`).

Check your work: `npm run edit -- <id> draft` renders `exports/videos/<id>.mp4` from the originals, then `npm run frames -- <id> 1 4.5 12` writes a contact sheet. Problems (missing media, scene file missing) are listed by the editor and in the render's lint output.

## Exporting

- PDF: studio "Export PDF" button, or `npm run pdf -- <deck>` → `exports/<deck>.pdf` (uses installed Edge/Chrome through playwright-core).
- Video: studio "Export video" button, or `npm run video -- <deck>` (add `draft` for a fast low-quality render) → `exports/<deck>.mp4`. Rendered by HyperFrames from a generated project in `exports/video/<deck>/`; FFmpeg comes from npm packages, telemetry is off.
- Check motion by eye without opening anything: `npm run frames -- <deck> 0.5 2 6.9` writes a labelled contact sheet of video frames to `exports/shots/<deck>-frames.png`. `npm run video-preview -- <deck>` opens HyperFrames' own preview studio (only when the owner asks; it opens a browser).
- Video project: editor "Render MP4" button or `npm run edit -- <id>` (`draft` for fast) → `exports/videos/<id>.mp4`, built in `exports/edit/<id>/` from the original footage.
- **Never open browser tabs or windows on the owner's machine** for checks; screenshots and frame sheets are headless.
