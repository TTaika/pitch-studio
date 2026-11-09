# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Vanilla HTML/CSS/JS studio served by a dependency-light Node server (no framework, no build step). Runs locally on the owner's Windows PC. Playwright (cached Chromium) for PDF export. HyperFrames planned for MP4 rendering (milestone 2).

## Users

One person: the owner, making pitch decks and short pitch videos for their own projects. They work alongside Claude Code in a terminal: Claude writes the slides, the owner reviews them in the studio and points at what to change.

## Product Purpose

Make pitch decks and videos that look good and look like *theirs*, in minutes instead of days. Humans take too long to make consistent decks; AI-generated decks are fast but generic and personality-free. Success: a deck the owner would present without apologising for it, made in one sitting, and each new deck needing fewer corrections than the last.

## Positioning

The studio is not an editor. Claude generates the HTML; the owner directs by pointing (click-and-comment), by moving and resizing elements, and by sketching layout blocks. Every direction is saved as a structured instruction in `feedback.json`, and recurring corrections are promoted into a persistent style profile, so the taste accumulates across decks.

## Operating Context

- Studio open in a desktop browser on a large monitor, next to a Claude Code terminal.
- Loop: Claude writes slides → owner reviews in studio → leaves comments / drags / sketches → asks Claude to apply feedback → studio live-reloads.
- Slides are HTML fragments on a fixed 1920×1080 canvas; the same HTML must later drive video frames.

## Capabilities and Constraints

- Milestone 1: slide strip + canvas, modes View / Comment / Adjust / Block, feedback list, PDF export, a starter style profile, one sample deck.
- Drag/resize and block sketches are layout *instructions* for Claude, not the final layout; slide files are never rewritten by the studio with absolute pixel positions.
- No WYSIWYG features: no rotation, layer panel, snapping engine, or multi-select alignment.
- Undecided: voiceover/music for video; whether feedback later moves from a file to an MCP tool.

## Brand Commitments

None yet. The owner has no reference decks; the starter style profile is Claude's opinionated pick, to be corrected through the loop.

## Evidence on Hand

None. Sample deck content pitches Pitch Studio itself; no customers, metrics, testimonials or pricing exist and must not be invented.

## Product Principles

1. Taste accumulates: a correction given once should not have to be given again.
2. Point, don't describe: any instruction that can be given by clicking or dragging should be.
3. The AI writes the code; the studio never fights it with hand-made pixel hacks.
4. One HTML source for deck, PDF and video.
