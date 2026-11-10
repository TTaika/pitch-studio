---
description: Apply the open studio feedback to a deck (or a video project) and learn lasting taste
argument-hint: "[deck-id] | video <video-id>  (defaults to the only deck, or asks)"
---

Arguments: `$ARGUMENTS`

- `video <id>` → apply the feedback of the **video project** `videos/<id>/` (section B).
- Otherwise it's a **deck** id (if empty: use the only deck in `decks/`, or ask which one when there are several) (section A).

## A. Deck

Follow the **Applying feedback** section of `CLAUDE.md` exactly. In short:

1. Read `profile/style.md` (including **Learned rules**) and `decks/<deck>/feedback.json`. Handle every item with `"status": "open"`; ignore the rest.
2. For each item, edit the slide files:
   - `comment`: change the element named by `target.el` / `target.selector` as the comment says. With a `time`, it's about the motion at that moment: use the levers in CLAUDE.md → Motion (`data-build*`, scene durations, or `profile/motion.js` for deck-wide taste).
   - `adjust`: rebuild the slide so the element lands at `to` (from `target.rect`) **through the theme's layout system**, never with absolute pixel positions.
   - `layout` with `slide` set: restructure that slide to match the labelled blocks. With `slide: null`: create a new slide at `insertAfter` and add it to `deck.json`.
3. Re-read `feedback.json` right before writing (the studio may have changed it), then set each handled item to `"status": "done"` with a one-sentence `"resolution"`, or `"wontfix"` with the reason. Leave other fields alone.
4. If a comment expresses taste that applies beyond that one element, append a dated rule under **Learned rules** in `profile/style.md`. Don't add rules for one-off content fixes.
5. Screenshot every slide you changed (`npm run shot -- <deck> <slide>`) and look at the images. For motion changes, `npm run video -- <deck> draft` then `npm run frames -- <deck> <seconds...>` around the moment. Fix anything broken before reporting. Never open browser windows.

## B. Video project

Follow the **Video projects** section of `CLAUDE.md`. In short:

1. Read `profile/style.md`, `videos/<id>/edit.json`, `videos/<id>/media.json` (what footage exists, its length) and `videos/<id>/feedback.json`. Handle every `"status": "open"` item.
2. Every item has a `time` (seconds on the video's timeline) and usually a `clip` (the id of the main-track item or overlay it's about). `until` means it's about the stretch `time`–`until`. To see the moment: `npm run edit -- <id> draft`, then `npm run frames -- <id> <seconds...>`.
   - `comment` on an overlay (`clip` is an overlay id): edit that overlay in `edit.json` (text, start, duration, anim, box).
   - `comment` on footage (`target.src`, `target.mediaTime`): change the cut in `edit.json` (trim `in`/`out`, split, reorder, remove, add an overlay over it). "Animate the product here" → write an animation scene (below) and put it on the main track or as an `anim` overlay.
   - `comment` with `slide` set: it's about a deck slide inside a deck clip. Change the slide in `decks/<deck>/slides/` (deck rules apply) unless it's about timing in this video, then use the clip's `durations`.
   - `comment` on a scene (`clip` is a `scene` item): edit `videos/<id>/scenes/<name>.html/.css/.js`.
   - `layout`: labelled blocks sketched on the frame between `time` and `until`. Build them as overlays (`edit.json` overlays with those boxes) or as an animation scene when a block needs real motion.
   - `animation`: the owner asked for a new full-frame animation with **+ Animation**. `clip` is its placeholder `scene` item, `target.scene` the scene name, `comment` what it should show. Write `videos/<id>/scenes/<target.scene>.html/.css/.js` for the clip's `duration` (CLAUDE.md → Animation scenes). Frame it around their words, use their real screenshots from `media/` where the prompt is about their product, and don't invent data.
   - A comment about how one clip leads into the next ("make this cut softer", "slide the next one in") → set `transition` on the later main item (CLAUDE.md → Transitions).
3. Edit `edit.json` carefully: re-read it right before writing, keep every id you don't remove, give new items new unique ids. The studio shows the change live.
4. Re-read `feedback.json`, mark items `done` with a one-sentence `resolution` (or `wontfix` with why). Promote lasting taste to **Learned rules** in `profile/style.md` as for decks.
5. Verify: `npm run edit -- <id> draft` and `npm run frames -- <id> <seconds...>` around every moment you changed; look at the sheet. Never open browser windows.

Finish with a short report: what changed per item, any wontfix and why, and the exact rules added to the style profile (or "no new rules").
