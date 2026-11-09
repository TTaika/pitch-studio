---
description: Apply the open studio feedback to a deck's slides and learn lasting taste
argument-hint: "[deck-id]  (defaults to the only deck, or asks)"
---

Apply the open feedback for deck `$ARGUMENTS` (if empty: use the only deck in `decks/`, or ask which one when there are several).

Follow the **Applying feedback** section of `CLAUDE.md` exactly. In short:

1. Read `profile/style.md` (including **Learned rules**) and `decks/<deck>/feedback.json`. Handle every item with `"status": "open"`; ignore the rest.
2. For each item, edit the slide files:
   - `comment`: change the element named by `target.el` / `target.selector` as the comment says. With a `time`, it's about the motion at that moment: use the levers in CLAUDE.md → Motion (`data-build*`, scene durations, or `profile/motion.js` for deck-wide taste).
   - `adjust`: rebuild the slide so the element lands at `to` (from `target.rect`) **through the theme's layout system**, never with absolute pixel positions.
   - `layout` with `slide` set: restructure that slide to match the labelled blocks. With `slide: null`: create a new slide at `insertAfter` and add it to `deck.json`.
3. Re-read `feedback.json` right before writing (the studio may have changed it), then set each handled item to `"status": "done"` with a one-sentence `"resolution"`, or `"wontfix"` with the reason. Leave other fields alone.
4. If a comment expresses taste that applies beyond that one element, append a dated rule under **Learned rules** in `profile/style.md`. Don't add rules for one-off content fixes.
5. Screenshot every slide you changed (`npm run shot -- <deck> <slide>`) and look at the images. For motion changes, `npm run video -- <deck> draft` then `npm run frames -- <deck> <seconds...>` around the moment. Fix anything broken before reporting. Never open browser windows.

Finish with a short report: what changed per slide, any items marked wontfix and why, and the exact rules added to the style profile (or "no new rules").
