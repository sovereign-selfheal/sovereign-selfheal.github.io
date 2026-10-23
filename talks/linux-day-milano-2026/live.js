// One widget of the site alone in the frame of a slide (live-*.html), or the recording of the demo.
// It scales the widget to the frame (whole, and as large as possible), passes the slide keys (also
// those of a presenter's remote) to the deck around the frame, and runs the actions that the deck
// sends: next or previous example, play or pause.
(function () {
  "use strict";
  const box = document.querySelector(".fit");  // none on the recording page: the video fits by CSS
  const MAX_SCALE = 1.6;
  const TARGET = location.protocol === "file:" ? "*" : location.origin;
  let tallest = 0;  // the widget changes height with its content: fit the tallest state, so the scale stays still

  function fit() {
    if (!box) return;
    const w = box.offsetWidth;
    tallest = Math.max(tallest, box.offsetHeight);
    if (!w || !tallest) return;
    const k = Math.min(window.innerWidth / w, window.innerHeight / tallest, MAX_SCALE);
    if (!(k > 0)) return;
    const x = Math.max(0, (window.innerWidth - w * k) / 2);
    const y = Math.max(0, (window.innerHeight - tallest * k) / 2);
    box.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  }

  window.addEventListener("resize", fit);
  window.addEventListener("load", fit);
  if (box && "ResizeObserver" in window) new ResizeObserver(fit).observe(box);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  fit();

  // Slide keys go to the deck. Arrows and Space stay with the widget when one of its controls has the
  // focus; Page Up and Page Down (a presenter's remote) always change the slide.
  const SLIDE_KEYS = { PageDown: "next", PageUp: "prev", ArrowRight: "next", ArrowLeft: "prev", " ": "next" };
  document.addEventListener("keydown", (e) => {
    if (window.parent === window || e.altKey || e.ctrlKey || e.metaKey) return;
    const move = SLIDE_KEYS[e.key];
    if (!move) return;
    const onControl = e.target && e.target.closest && e.target.closest("button, a, input, select, textarea");
    if (onControl && e.key !== "PageDown" && e.key !== "PageUp") return;
    e.preventDefault();
    window.parent.postMessage({ deckKey: move }, TARGET);
  });

  // Actions from the deck: the simulator has Previous, Next and Play buttons; the replay has one chip
  // per investigation and a Play button.
  function press(selector) {
    const b = document.querySelector(selector);
    if (b) b.click();
    return Boolean(b);
  }
  function chip(step) {
    const chips = Array.from(document.querySelectorAll("#replay-pick .chip"));
    if (!chips.length) return false;
    const now = Math.max(0, chips.findIndex((c) => c.getAttribute("aria-pressed") === "true"));
    chips[(now + step + chips.length) % chips.length].click();
    return true;
  }
  // The recording (live-video.html): P plays or pauses, ↓ ↑ jump 10 seconds. It is muted, so the
  // browser lets it play from a key pressed in the deck.
  const video = document.querySelector("video");
  function seek(seconds) {
    if (!video) return false;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
    return true;
  }
  function playVideo() {
    if (!video) return false;
    if (video.paused || video.ended) video.play().catch(() => { /* no file: the page says so */ });
    else video.pause();
    return true;
  }
  if (video) {
    const missing = () => { document.getElementById("video-missing").hidden = false; };
    video.addEventListener("error", missing);
    if (video.error) missing();
  }

  const ACTIONS = {
    next: () => press("#sim-next") || chip(1) || seek(10),
    prev: () => press("#sim-prev") || chip(-1) || seek(-10),
    play: () => press("#sim-play") || press("#replay-play") || playVideo(),
  };
  window.addEventListener("message", (e) => {
    if (location.protocol !== "file:" && e.origin !== location.origin) return;
    const d = e.data;
    if (d && typeof d.liveAction === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, d.liveAction)) {
      ACTIONS[d.liveAction]();
    }
  });
})();
