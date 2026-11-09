---
name: Pitch Studio
description: Platform Signage deck style (profile/theme.css) plus the quiet dark studio that directs it.
colors:
  sign: "#1e2124"
  sign-2: "#2b2f33"
  platform: "#e4e7e9"
  platform-2: "#cfd3d6"
  white: "#ffffff"
  signal: "#ff6319"
  ink-2: "#4a5056"
  on-sign-2: "#b4b9be"
  studio-ground: "#141516"
  studio-shell: "#1c1d1f"
  studio-raise: "#25262a"
  studio-text: "#ecedee"
  studio-accent: "#d4ff3f"
  studio-block: "#7fd3ff"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "156px"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "96px"
    fontWeight: 700
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  station:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "64px"
    fontWeight: 700
    lineHeight: 0.95
  body:
    fontFamily: "Barlow, Arial, sans-serif"
    fontSize: "34px"
    fontWeight: 500
    lineHeight: 1.35
  studio-ui:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  none: "0px"
  studio: "6px"
  stop: "50%"
spacing:
  margin: "96px"
  sign-inset: "48px"
  band: "300px"
  gutter: "64px"
components:
  sign-band:
    backgroundColor: "{colors.sign}"
    textColor: "{colors.white}"
    typography: "{typography.headline}"
    rounded: "{rounded.none}"
    height: "252px"
  stop-roundel:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.sign}"
    rounded: "{rounded.stop}"
    size: "112px"
  studio-button-primary:
    backgroundColor: "{colors.studio-text}"
    textColor: "{colors.studio-ground}"
    rounded: "{rounded.studio}"
    height: "34px"
    padding: "0 12px"
  studio-button:
    backgroundColor: "{colors.studio-raise}"
    textColor: "{colors.studio-text}"
    rounded: "{rounded.studio}"
    height: "34px"
    padding: "0 12px"
---

# Design System: Pitch Studio

## Overview

**Creative North Star: "Every slide is a station sign."**

Two surfaces share this project. The **deck style** (`profile/theme.css`) is Platform Signage, after Nordic transit wayfinding: charcoal enamel sign panels mounted on cool platform grey, condensed sign lettering, heavy arrows, and a route line that tells the viewer where they are in the deck. It is a starter style the owner corrects through feedback, so `profile/style.md` holds its living rules. The **studio** is a working tool: a dark, neutral surround so slide colours are judged true, with one highlighter accent that marks only what you are pointing at.

**Key Characteristics:**
- One statement per slide, left-aligned, set big in Barlow Condensed.
- Orange means "you are here" and nothing else.
- Position is injected by the server (stop roundel and route line); slides never number themselves.
- The studio stays quiet so the slide is the loudest thing on screen.

## Colors

### Primary
- **Signal orange `#ff6319`**: the stop roundel, the route-line stop, and at most one focus element per slide.

### Neutral
- **Sign `#1e2124`**: panels, primary ink on platform. **Sign-2 `#2b2f33`**: rules on a sign.
- **Platform `#e4e7e9`**: the ground. **Platform-2 `#cfd3d6`**: rules on the ground.
- **Ink-2 `#4a5056`** (6.4:1 on platform) and **On-sign-2 `#b4b9be`** (8:1 on sign) for secondary text.

### Studio
- Ground `#141516`, shell `#1c1d1f`, raised `#25262a`, text `#ecedee`.
- **Highlighter `#d4ff3f`**: hover outline, comment pins, the selection. **Block blue `#7fd3ff`**: layout sketches only.

### Named Rules
**The You-Are-Here Rule.** Orange appears on the roundel, the route-line stop, and at most one focus element. A second stop marker, a background, or decoration in orange breaks the sign.

## Typography

**Display font:** Barlow Condensed 600/700/800 (self-hosted, OFL), drawn after highway sign lettering.
**Body font:** Barlow 400/500/600.
**Studio:** the Windows system UI stack; Cascadia Mono for coordinates and element ids.

### Hierarchy
- **Display** (800, 156px, 0.9): title and close slides only.
- **Headline** (700, 96px): in the sign band of content slides. Statement slides use 128px.
- **Station** (700, 52–64px): station names, platform titles, board destinations. Sentence case, never tracked caps.
- **Body** (500, 30–38px): never below 30px on the 1920 canvas.

### Named Rules
**The No-Eyebrow Rule.** No small tracked uppercase labels above headings; a label that names a station is set as a station name.

## Layout

A fixed 1920×1080 canvas with a 96px margin. Content slides hang a sign band (inset 48px, 252px tall) at the top with the roundel inside it, and the body below it runs from 380px down to 900px. The route line sits 64px above the bottom edge on every slide. Layouts: `title`, `statement`, `split`, `steps`, `figure`, `board`, `timeline`, `close`. The studio is a three-column grid (strip 212 / stage / panel 340) that narrows to 172 / 288 at 1440px and drops its button labels at 1100px. The feedback panel collapses (the top-bar toggle or `F`) so the slide under review can take the width.

## Elevation & Depth

Slides are flat: no shadows, gradients or glows. Depth is only the panel's charcoal against the platform grey. In the studio, the canvas lifts off the ground with `0 18px 48px rgba(0,0,0,.45)`, and the popover and toast carry soft offset shadows.

## Shapes

Slide shapes are square-cornered panels plus circles for stops. The transit arrow is one authored SVG path (`M6 41h58L42 19h26l28 31-28 31H42l22-22H6z`), rotated via `.up` / `.down` / `.left` / `.up-right`. Studio controls use a 6px radius; comment pins are speech-shaped (11px radius with one 3px corner).

## Components

### Sign band
A charcoal panel inset 48px from the slide edges, holding the roundel and the headline. Never full-bleed.

### Route line
Server-injected `.ps-route`: a 6px line with 26px stops. Past stops are filled, the current stop is orange and 36px.

### Direction board (signature)
`[data-layout="board"]`: rows of destination (88px condensed), detail and a 120px arrow on a charcoal sign. Use it when one thing leads to several outcomes, at most once per deck.

### Scene transport
A bar under the canvas, exactly as wide as the slide: a play/pause icon button, a full-width scrubber and a mono time readout. The readout turns highlighter-coloured whenever the slide is off its settled frame, and comments made there carry an "at 0.7s" chip.

### Studio mode switch
A segmented radio group (View / Comment / Adjust / Block) with key hints. The active mode is `#3a3d42` with an inset border, and its icon takes the highlighter colour (block blue in Block mode).

## Do's and Don'ts

### Do:
- **Do** write headlines as claims ("Two ways to make a deck. Both bad.").
- **Do** give every meaningful element a `data-el` name.
- **Do** put numbers in `table.ruled` with units.

### Don't:
- **Don't** use orange for anything but "you are here" plus one focus element.
- **Don't** centre text, use gradients or glass, or build icon-tile card grids.
- **Don't** hard-code slide numbers or absolute pixel positions in slide files.
