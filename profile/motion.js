/* Motion grammar for Platform Signage. Part of the style profile: how slides move is taste too.
   Every slide builds in the same printing order: ground → sign panel → stop roundel →
   headline → content → focus (orange) last, then leaves like a train pulling out.
   Used by the studio preview (one slide) and the video (all slides back to back), so
   both always agree. Deterministic: only seekable GSAP tweens, no timers, no randomness.

   Per-element levers for slide authors:
     data-build="none"      never animate this element
     data-build="focus"     treat it as the slide's focus (enters last)
     data-build-at="1.6"    start this element's entrance at 1.6s into the scene */
(function (global) {
  var EXIT = 0.45;

  // Role selectors, in build order. An element takes the first role that claims it.
  var ROLES = [
    { name: 'focus', sel: '[data-build="focus"], .go, em.focus, .ps-route li.here' },
    { name: 'panel', sel: '.panel, .band, .board' },
    { name: 'stop', sel: '.ps-stop' },
    { name: 'route', sel: '.ps-route ol' },
    { name: 'headline', sel: 'h1, .band h2, [data-layout="close"] h2, .statement' },
    { name: 'content', sel: '.sub, .note, .platform, .station, .stop, .shot, .caption, .board li, .cmd, table.ruled, .body > p' },
  ];

  function build(tl, section, start, duration, opts) {
    opts = opts || {};
    if (!section) return { rest: duration };
    var exit = opts.exit !== false && duration > 2;
    var rest = exit ? duration - EXIT : duration;
    var claimed = [];
    var byRole = {};
    ROLES.forEach(function (role) {
      byRole[role.name] = Array.prototype.filter.call(section.querySelectorAll(role.sel), function (el) {
        if (el.getAttribute('data-build') === 'none' || claimed.indexOf(el) >= 0) return false;
        claimed.push(el);
        return true;
      });
    });

    function at(el, t) {
      var custom = parseFloat(el.getAttribute('data-build-at'));
      return start + (isNaN(custom) ? t : custom);
    }

    // Panel: the sign is hung first, dropping a short way into place.
    byRole.panel.forEach(function (el) {
      tl.from(el, { y: -48, opacity: 0, duration: 0.5, ease: 'power3.out' }, at(el, 0.05));
    });
    // Route line fades in under everything.
    byRole.route.forEach(function (el) {
      tl.from(el, { opacity: 0, duration: 0.5, ease: 'power1.out' }, at(el, 0.2));
    });
    // Stop roundel: snaps on like a lit sign.
    byRole.stop.forEach(function (el) {
      tl.from(el, { scale: 0.3, opacity: 0, duration: 0.35, ease: 'back.out(2)' }, at(el, 0.3));
    });
    // Headline: slides in from the left edge, reading direction.
    byRole.headline.forEach(function (el, i) {
      tl.from(el, { x: -90, opacity: 0, duration: 0.6, ease: 'power3.out' }, at(el, 0.4 + i * 0.1));
    });
    // Content: rises into place one piece at a time, left to right, top to bottom.
    var t = 0.85;
    byRole.content.forEach(function (el) {
      tl.from(el, { y: 32, opacity: 0, duration: 0.5, ease: 'power2.out' }, at(el, t));
      t += 0.14;
    });
    // Focus: last, the one orange thing, with a small overshoot.
    var focusAt = Math.max(1.1, t + 0.1);
    byRole.focus.forEach(function (el) {
      tl.from(el, { scale: 0.4, opacity: 0, duration: 0.45, ease: 'back.out(2.2)' }, at(el, focusAt));
    });

    // Leave: the whole slide pulls out to the left.
    if (exit) {
      tl.to(section, { x: -140, opacity: 0, duration: EXIT, ease: 'power2.in' }, start + rest);
    }
    // Keep the timeline exactly as long as the scene even when nothing animates late.
    tl.set({}, {}, start + duration);
    // "rest" is the settled frame: everything in, nothing leaving yet.
    return { rest: rest };
  }

  global.PitchMotion = { build: build, EXIT: EXIT };
})(typeof window !== 'undefined' ? window : globalThis);
