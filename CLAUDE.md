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
   - `comment`: `target.selector` / `target.el` names the element, `target.text` is what it said, `comment` is the instruction. If `target.selector` is `section.slide`, it's about the whole slide.
   - `adjust`: the owner dragged/resized the element from `target.rect` to `to`. Rebuild the slide so the element lands there **through the layout system** (grid columns, theme spacing, sizes): never paste absolute `left/top` pixels. Match within ~2% of the canvas; if the theme grid can't express it, say so in the resolution. `comment` may explain why.
   - `layout`: `blocks` is a sketch: labelled rectangles saying what goes where. With `slide` set, restructure that slide to match. With `slide: null`, create a **new slide** at `insertAfter` (null = first): add the slide file and insert its id into `deck.json`.
3. Edit the slide files. Then update each handled item in `feedback.json`: set `"status": "done"` and add `"resolution": "<one short sentence on what changed>"`. If you deliberately did not do something, use `"status": "wontfix"` and say why. Keep every other field as is. Edit the JSON carefully: the studio is writing to it too, so re-read it right before you write it.
4. **Learn.** If a comment expresses taste that would apply beyond this one element ("too corporate", "never centre text", "numbers need units"), add it as a one-line rule under **Learned rules** in `profile/style.md` (with the date). Don't add one-off content fixes. Tell the owner which rules you added.
5. Verify by screenshot before reporting: `npm run shot -- <deck> <slide>` writes `exports/shots/<deck>-<slide>.png`; look at it.

## Exporting

- PDF: studio "Export PDF" button, or `npm run pdf -- <deck>` → `exports/<deck>.pdf` (uses installed Edge/Chrome through playwright-core).
- Video (HyperFrames) is milestone 2: keep slides free of anything that can't render deterministically (no random values, no external fonts/CDNs, no autoplaying media).
