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

## Where things live

- `profile/`: your style profile (`style.md` rules, `theme.css` look, fonts). Shared by every deck.
- `decks/<id>/`: `deck.json` (slide order), `slides/*.html`, `assets/`, `feedback.json`.
- `exports/`: PDFs and screenshots.

- `profile/motion.js`: how slides move (part of your style).
