# Style profile

The owner's taste, written down. Read this before writing any slide. Visual tokens and layout classes live in `theme.css`; this file holds the rules the CSS can't enforce.

**Current look: Platform Signage.** Every slide is a station sign: one statement, one direction, and the viewer always knows where they are and where it goes next. (Starter style picked by Claude on 2026-11-09; the owner corrects it through feedback.)

## Voice

- Short, blunt, confident. A headline is a claim, not a topic: "Two bad options", not "The Problem".
- Plain words. Never: revolutionize, seamless, leverage, unlock, empower, next-generation, game-changer, cutting-edge.
- One idea per slide. If it needs two headlines, it's two slides.
- No invented facts. Unknown numbers become visible placeholders: `[users — fill in]`.

## Layout grammar

- Layouts in `theme.css`: `title`, `statement`, `split`, `steps`, `figure`, `board`, `timeline`, `close`. Pick by what the content does, not for variety.
- Content slides use the charcoal header **band** with the headline; the body sits on the platform grey below.
- A run of three or more content slides gets broken by a `statement` slide (full charcoal).
- Left-aligned, always. Nothing centred.
- `board` (direction board) is the signature: use it when one thing leads to several outcomes. At most once per deck.

## Colour

- Orange (`--signal`) means **you are here**: the stop roundel and route-line stop (both injected), plus **at most one** focus element per slide (a key word as `<em class="focus">`, the onward arrow). Never on a second stop marker, never as decoration, never as a background.
- Content sign bands are mounted signs: inset with platform grey around them, never full-bleed title bars.
- Everything else is charcoal, platform grey and white.

## Type

- Headlines in Barlow Condensed, body in Barlow. Body text at least 30px on the 1920 canvas.
- Every number carries its unit and sits in a `table.ruled`. No floating big-number stickers.

## Motion

Implemented in `motion.js`; these are the rules it encodes.
- Fixed build order on every slide: sign panel drops in → stop roundel snaps on → headline slides in from the left → content rises piece by piece → orange focus lands last with a small overshoot.
- Each slide leaves like a train pulling out: a short push to the left over platform grey. No fades to black, no spins, no zooms.
- Scenes are as long as reading takes (about 4 words a second), 4–8 seconds.

## Bans

- Gradients, glows, glass, drop shadows on slide content.
- Icon-tile grids (icon + heading + text in equal cards).
- Small tracked uppercase labels above headlines (eyebrows). Station names are set big, in sentence case.
- Stock photos of people pointing at laptops.

## Learned rules

<!-- Claude appends here when a correction expresses taste that applies beyond one element.
     Format: - YYYY-MM-DD: rule (from: deck/slide, item id) -->
