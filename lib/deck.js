// Deck loading, slide fragments and scene timing. Shared by the studio server
// and the video builder so a slide renders identically in both.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DECKS = path.join(ROOT, 'decks');
const SLUG = /^[a-z0-9][a-z0-9-_]*$/i;

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function deckDir(deck) {
  if (!SLUG.test(deck)) return null;
  const dir = path.join(DECKS, deck);
  return fs.existsSync(path.join(dir, 'deck.json')) ? dir : null;
}

function loadDeck(deck) {
  const dir = deckDir(deck);
  if (!dir) return null;
  const meta = readJSON(path.join(dir, 'deck.json'), null);
  if (!meta) return null;
  meta.id = deck;
  meta.slides = (meta.slides || []).filter((id) => SLUG.test(id));
  return meta;
}

// The server also injects the deck's position (stop number + route line) so slides
// never hard-code their own number; the theme decides how, or whether, to show it.
function routeNav(index, count) {
  const stops = Array.from({ length: count }, (_, i) => `<li${i === index ? ' class="here"' : i < index ? ' class="past"' : ''}></li>`).join('');
  return `<nav class="ps-route" aria-hidden="true"><span class="ps-stop">${String(index + 1).padStart(2, '0')}</span><ol>${stops}</ol></nav>`;
}

// One slide file is one <section class="slide"> fragment on a 1920x1080 canvas.
function slideFragment(meta, id) {
  const file = path.join(DECKS, meta.id, 'slides', `${id}.html`);
  let html;
  try { html = fs.readFileSync(file, 'utf8'); } catch {
    return `<section class="slide ps-missing"><p>Missing slide file: slides/${id}.html</p></section>`;
  }
  const at = html.lastIndexOf('</section>');
  const index = meta.slides.indexOf(id);
  if (at >= 0 && index >= 0) html = html.slice(0, at) + routeNav(index, meta.slides.length) + html.slice(at);
  return html;
}

// Scene length: deck.json "video.durations" wins; otherwise long enough to read the
// slide (about 4 words a second on top of the build-in), clamped to 4–8 seconds.
function sceneDuration(meta, id, fragment) {
  const override = meta.video?.durations?.[id];
  if (typeof override === 'number' && override > 0) return override;
  const words = fragment
    .replace(/<nav class="ps-route"[\s\S]*?<\/nav>/, '')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/).filter(Boolean).length;
  return Math.round(Math.min(8, Math.max(4, 2 + words * 0.25)) * 10) / 10;
}

module.exports = { ROOT, DECKS, SLUG, readJSON, deckDir, loadDeck, slideFragment, sceneDuration };
