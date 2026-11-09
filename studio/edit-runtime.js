/* Preview runtime for /render-edit/<id>. HyperFrames does this itself when rendering; in
   the studio we drive the same page: one clock seeks the GSAP timeline, shows each clip
   only inside [start, start + duration), and keeps <video>/<audio> on the clock.
   The editor talks to it through window.__pe (same origin, inside the preview iframe). */
(function () {
  var tl = window.__timelines.root;
  var duration = window.__peModel.duration;
  var clips = Array.prototype.slice.call(document.querySelectorAll('#root > .clip'));
  var t = 0, playing = false, n0 = 0, t0 = 0, raf = 0;

  clips.forEach(function (el) {
    el._start = parseFloat(el.getAttribute('data-start')) || 0;
    el._end = el._start + (parseFloat(el.getAttribute('data-duration')) || 0);
    el._media = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
    el._from = parseFloat(el.getAttribute('data-media-start')) || 0;
    if (el._media) {
      var vol = parseFloat(el.getAttribute('data-volume'));
      el.volume = Math.max(0, Math.min(1, isNaN(vol) ? 1 : vol));
    }
  });

  function syncMedia(el, on) {
    if (!on) { if (!el.paused) el.pause(); return; }
    var target = el._from + (t - el._start);
    if (playing) {
      if (el.paused) {
        el.currentTime = target;
        var p = el.play();
        // Autoplay with sound can be refused; keep the picture moving muted.
        if (p && p.catch) p.catch(function () { el.muted = true; el.play().catch(function () {}); });
      } else if (Math.abs(el.currentTime - target) > 0.25) el.currentTime = target;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
    }
  }

  function apply() {
    tl.seek(Math.min(t, duration), false);
    for (var i = 0; i < clips.length; i++) {
      var el = clips[i];
      var on = t >= el._start && t < el._end;
      if (el.tagName !== 'AUDIO') el.style.visibility = on ? 'visible' : 'hidden';
      if (el._media) syncMedia(el, on);
    }
    if (api.onTick) api.onTick(t, playing);
  }

  function frame(now) {
    t = t0 + (now - n0) / 1000;
    if (t >= duration) { t = duration; playing = false; apply(); return; }
    apply();
    raf = requestAnimationFrame(frame);
  }

  var api = {
    duration: duration,
    warnings: window.__peModel.warnings,
    onTick: null,
    get time() { return t; },
    get playing() { return playing; },
    seek: function (s) {
      t = Math.max(0, Math.min(duration, s));
      if (playing) { t0 = t; n0 = performance.now(); }
      apply();
    },
    play: function () {
      if (playing) return;
      if (t >= duration - 0.01) t = 0;
      playing = true; t0 = t; n0 = performance.now();
      apply();
      raf = requestAnimationFrame(frame);
    },
    pause: function () {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(raf);
      apply();
    },
    // Clip (main or overlay) showing at time s that contains the point, topmost first.
    clipsAt: function (s) {
      return clips.filter(function (el) { return s >= el._start && s < el._end && el.tagName !== 'AUDIO'; })
        .sort(function (a, b) { return (parseInt(b.style.zIndex) || 0) - (parseInt(a.style.zIndex) || 0); });
    },
  };
  window.__pe = api;
  apply();
})();
