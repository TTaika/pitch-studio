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

  // Overlays on footage (titles, labels, arrows...): one short entrance, hold, a quick
  // fade before the clip ends. fromTo so seeking backwards is always exact.
  var OVERLAY_OUT = 0.3;
  var ENTER = {
    fade: [{ opacity: 0 }, { opacity: 1, duration: 0.35, ease: 'power1.out' }],
    rise: [{ y: 36, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'power3.out' }],
    slide: [{ x: -90, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, ease: 'power3.out' }],
    pop: [{ scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.2)' }],
    wipe: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: 0.6, ease: 'power2.inOut' }],
  };
  function overlay(tl, el, start, duration, anim) {
    if (!el) return;
    var enter = ENTER[anim];
    if (enter) tl.fromTo(el, enter[0], enter[1], start);
    if (duration > 1) tl.to(el, { opacity: 0, duration: OVERLAY_OUT, ease: 'power1.in' }, start + duration - OVERLAY_OUT - 0.02);
  }

  // Transitions between main-track clips (edit.json main[i].transition). `from` and `to`
  // overlap for `d` seconds starting at `start`; `to` paints above `from`, `layer` (dip
  // colour, route line) above both. Tweens on `from` don't render early (it may already
  // carry its own entrance), so seeking either way lands on the exact frame.
  var TX_EASE = 'power2.inOut';
  var PUSH = { left: ['x', -1920], right: ['x', 1920], up: ['y', -1080], down: ['y', 1080] };
  // Where the incoming clip is still hidden: the side the edge travels from.
  var WIPE = { left: 'inset(0% 0% 0% 100%)', right: 'inset(0% 100% 0% 0%)', up: 'inset(100% 0% 0% 0%)', down: 'inset(0% 0% 100% 0%)' };
  function transition(tl, from, to, layer, start, d, kind, dir) {
    if (!to) return;
    var late = { immediateRender: false };
    if (kind === 'crossfade') {
      tl.fromTo(to, { opacity: 0 }, { opacity: 1, duration: d, ease: 'none' }, start);
    } else if (kind === 'dip') {
      // Out to the colour, swap underneath, back in from it.
      var dip = layer && layer.querySelector('.tx-dip');
      tl.fromTo(to, { opacity: 0 }, { opacity: 1, duration: 0.001 }, start + d / 2);
      if (dip) {
        tl.fromTo(dip, { opacity: 0 }, { opacity: 1, duration: d / 2, ease: 'power1.in' }, start);
        tl.fromTo(dip, { opacity: 1 }, Object.assign({ opacity: 0, duration: d / 2, ease: 'power1.out' }, late), start + d / 2);
      }
    } else if (kind === 'wipe') {
      tl.fromTo(to, { clipPath: WIPE[dir] || WIPE.left }, { clipPath: 'inset(0% 0% 0% 0%)', duration: d, ease: TX_EASE }, start);
    } else if (kind === 'push') {
      var p = PUSH[dir] || PUSH.left, a = {}, b = {}, c = {}, e = {};
      a[p[0]] = -p[1]; b[p[0]] = 0; c[p[0]] = 0; e[p[0]] = p[1];
      tl.fromTo(to, a, Object.assign(b, { duration: d, ease: TX_EASE }), start);
      if (from) tl.fromTo(from, c, Object.assign(e, { duration: d, ease: TX_EASE }, late), start);
    } else if (kind === 'route') {
      // The route line sweeps across and the next clip is revealed behind it.
      var right = dir === 'right' || dir === 'down';
      var line = layer && layer.querySelector('i');
      tl.fromTo(to, { clipPath: right ? WIPE.right : WIPE.left }, { clipPath: 'inset(0% 0% 0% 0%)', duration: d, ease: TX_EASE }, start);
      if (line) tl.fromTo(line, { x: right ? 0 : 1920 }, { x: right ? 1920 : 0, duration: d, ease: TX_EASE }, start);
    }
  }

  // Animation scenes Claude writes per video project (videos/<id>/scenes/<name>.js):
  //   PitchScenes.register('name', function (tl, root, start, duration) { tl.fromTo(...) });
  // A scene without a script falls back to the slide grammar, so plain markup still moves.
  var scenes = {};
  global.PitchScenes = {
    register: function (name, fn) { scenes[name] = fn; },
    run: function (name, tl, root, start, duration) {
      if (scenes[name]) scenes[name](tl, root, start, duration);
      else build(tl, root, start, duration, { exit: false });
    },
  };

  global.PitchMotion = { build: build, overlay: overlay, transition: transition, EXIT: EXIT };
})(typeof window !== 'undefined' ? window : globalThis);
