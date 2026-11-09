# Pitch Studio

Local tool for making personal pitch decks (and, from milestone 2, videos). Claude writes slides as HTML; the owner reviews them in the studio and points at what to change; Claude applies that feedback and records the taste it learns.

Run: `npm start` → http://127.0.0.1:4173/ (`?deck=<id>` picks a deck). The studio live-reloads whenever a slide, theme, or feedback file changes.

## Layout

```
profile/style.md     The style profile: voice, layout grammar, bans, learned rules. READ BEFORE WRITING ANY SLIDE.
profile/theme.css    Design tokens + slide layout classes shared by every deck.
decks/<id>/deck.json { "title": "...", "slides": ["title", "problem", ...] }   ← order lives here
decks/<id>/slides/<slide>.html   One <section class="slide"> fragment, 1920×1080 canvas.
decks/<id>/deck.css  Optional per-deck overrides (keep tiny; taste belongs in the profile).
decks/<id>/assets/   Images for the deck (reference as assets/x.png; the render page has <base href="/decks/<id>/">).
decks/<id>/feedback.json  Written by the studio. You read it and mark items done.
studio/              The studio UI (vanilla JS). server.js serves everything.
exports/             PDF output (gitignored).
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

## Exporting

- PDF: studio "Export PDF" button, or `npm run pdf -- <deck>` → `exports/<deck>.pdf` (uses installed Edge/Chrome through playwright-core).
- Video: studio "Export video" button, or `npm run video -- <deck>` (add `draft` for a fast low-quality render) → `exports/<deck>.mp4`. Rendered by HyperFrames from a generated project in `exports/video/<deck>/`; FFmpeg comes from npm packages, telemetry is off.
- Check motion by eye without opening anything: `npm run frames -- <deck> 0.5 2 6.9` writes a labelled contact sheet of video frames to `exports/shots/<deck>-frames.png`. `npm run video-preview -- <deck>` opens HyperFrames' own preview studio (only when the owner asks; it opens a browser).
- **Never open browser tabs or windows on the owner's machine** for checks; screenshots and frame sheets are headless.
