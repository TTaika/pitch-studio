# Pitch Studio

Personal pitch decks that look like *you* made them. Claude writes the slides as HTML; you direct by pointing.

```
npm install
npm start            # → http://127.0.0.1:4173/
```

## The loop

1. Ask Claude Code for a deck ("make a deck about X", it follows `CLAUDE.md` and `profile/style.md`).
2. Open the studio and direct it:

   | Key | Mode | What you do |
   |---|---|---|
   | `V` | View | Look. `←` `→` change slides. |
   | `C` | Comment | Click any element, say what's wrong. `↑` in the popover selects the parent. |
   | `A` | Adjust | Drag an element where it belongs, drag handles to resize, arrows nudge. `Delete` reverts. |
   | `F` | (any) | Show or hide the feedback panel, for more room on the slide. |
   | `B` | Block | Draw labelled boxes for the layout you want. "Sketch new slide" sketches a slide that doesn't exist yet. |

3. In Claude Code (started in this folder) run `/apply-feedback <deck>`. The **Copy prompt for Claude** button copies exactly that. Claude applies everything, marks items done with a note, and adds lasting taste to `profile/style.md` → *Learned rules*.
4. **Export PDF** or **Export video** when it's right (`npm run pdf -- <deck>`, `npm run video -- <deck>`).

### Motion and video

Every slide is also a video scene. Press `Space` (or the play button under the slide) to play its motion, or drag the scrubber. Comment while scrubbed and the comment remembers the moment ("at 0.7s"), so you can direct the motion too ("headline should arrive faster"). The video is rendered by HyperFrames from the same slides; FFmpeg is installed with `npm install`, nothing system-wide.

Moves and sketches are instructions, not edits: the studio never rewrites your slides. Claude rebuilds them properly through the layout system.

## Videos: your own footage

Open **Videos** in the top bar (http://127.0.0.1:4173/edit).

1. Create a video, then **Import** your clips (or drop files anywhere on the window; phone `.mov` works, a 720p preview copy is made for smooth scrubbing; renders use the originals).
2. Drag footage, deck slides and animations onto the **Main** lane; they play back to back. Drag edges to trim, drag clips to reorder, `S` splits at the playhead, `Delete` removes, `Ctrl+Z` undoes.
3. Add **overlays** over the picture (title, lower third, label, arrow, highlight). Edit their words in the Clip panel, drag them into place in Adjust (`A`).
4. Direct the AI like on slides: `C` and click anything at a moment ("cut this pause", "animate the product here"), drag along the ruler to comment on a stretch, `B` to sketch what should appear. Then **Copy prompt for Claude** (`/apply-feedback video <id>`): Claude recuts the edit, writes overlays and builds product animations as scenes.
5. **Render MP4** → `exports/videos/<id>.mp4`.

`npm run sample-video` makes a demo project from generated test footage. The deck's own **Export video** is unchanged; a deck can also be a clip in any video.

## Where things live

- `profile/`: your style profile (`style.md` rules, `theme.css` look, fonts). Shared by every deck.
- `decks/<id>/`: `deck.json` (slide order), `slides/*.html`, `assets/`, `feedback.json`.
- `videos/<id>/`: `edit.json` (the cut), `media/` (your footage, not committed), `scenes/` (animations), `feedback.json`.
- `exports/`: PDFs, MP4s and screenshots.

- `profile/motion.js`: how slides move (part of your style).
