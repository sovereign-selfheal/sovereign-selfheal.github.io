// Slide deck of a talk. No dependencies, nothing loaded from other sites; works offline from a local copy.
// 1920 x 1080 slides scaled to the window, keyboard and swipe navigation, the slide id in the URL,
// and a presenter view (current and next slide, notes, timer) in a second window or in this one.
(function () {
  "use strict";
  const W = 1920;
  const H = 1080;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const stage = $(".stage");
  const slides = $$(".slide", stage);
  const panel = $(".presenter");
  const nextStage = $(".next-stage");
  const notesPane = $(".presenter-notes");
  const notesBox = $(".presenter-notes-text");
  const countBox = $(".presenter-count");
  const elapsedBox = $(".elapsed");
  const clockBox = $(".clock");
  const help = $(".help");
  const status = $("#deck-status");

  // The two windows (audience and presenter) tell each other the current slide. Pages opened from
  // disk have an opaque origin (browsers show it as "null" or "file://"): they post to "*", and only
  // the deck's path in the message tells the two windows apart from other pages.
  const DECK = location.pathname;
  const FROM_DISK = location.protocol === "file:";
  const TARGET = FROM_DISK ? "*" : location.origin;
  const isPopup = new URLSearchParams(location.search).get("view") === "presenter";

  let current = -1;
  let peer = null;
  let started = Date.now();
  let timer = 0;

  // Size of the notes in the presenter view (+ and -), kept in this browser. 0: the size of the CSS.
  const NOTES_KEY = "deck-notes-size";
  let notesSize = 0;
  try {
    notesSize = Number(window.localStorage.getItem(NOTES_KEY)) || 0;
  } catch (e) { /* no storage: the size of the CSS */ }

  function applyNotesSize() {
    if (notesSize) notesBox.style.fontSize = notesSize + "px";
    else notesBox.style.removeProperty("font-size");
  }

  function resizeNotes(step) {
    const now = notesSize || parseFloat(getComputedStyle(notesBox).fontSize) || 24;
    notesSize = Math.max(14, Math.min(48, Math.round(now + step)));
    applyNotesSize();
    try {
      window.localStorage.setItem(NOTES_KEY, String(notesSize));
    } catch (e) { /* no storage: the size lasts until the page reloads */ }
  }

  // Scale the slides of a box so that a whole 1920 x 1080 slide fits in it.
  function fit(box) {
    const scale = Math.min(box.clientWidth / W, box.clientHeight / H);
    if (scale > 0) box.style.setProperty("--scale", String(scale));
  }
  function fitAll() {
    fit(stage);
    if (!panel.hidden) fit(nextStage);
  }

  function title(slide) {
    const h = $("h1, h2", slide);
    return h ? h.textContent.trim() : slide.id;
  }

  // #gate-privacy or #13 (1-based) in the URL.
  function indexFromHash() {
    const key = decodeURIComponent(location.hash.slice(1));
    if (/^\d+$/.test(key)) return Number(key) - 1;
    const n = slides.findIndex((s) => s.id === key);
    return n < 0 ? 0 : n;
  }

  // A copy of a slide for the "next" box: no ids, no notes, no live page (one copy of it is enough).
  function preview(slide) {
    const copy = slide.cloneNode(true);
    copy.hidden = false;
    copy.removeAttribute("id");
    copy.setAttribute("aria-hidden", "true");
    $$("[id]", copy).forEach((n) => n.removeAttribute("id"));
    $$(".notes", copy).forEach((n) => n.remove());
    $$("iframe", copy).forEach((frame) => {
      const p = document.createElement("p");
      p.className = "live-placeholder";
      p.textContent = frame.title;
      frame.replaceWith(p);
    });
    return copy;
  }

  function renderPresenter() {
    if (panel.hidden || current < 0) return;
    const slide = slides[current];
    const notes = $(".notes", slide);
    notesBox.textContent = notes ? notes.textContent.trim() : "";
    notesPane.scrollTop = 0;
    countBox.textContent = `${current + 1} / ${slides.length} · ${title(slide)}`;
    const next = slides[current + 1];
    if (next) {
      nextStage.replaceChildren(preview(next));
    } else {
      const end = document.createElement("p");
      end.className = "next-end";
      end.textContent = "End of the deck";
      nextStage.replaceChildren(end);
    }
    fit(nextStage);
  }

  function tell() {
    if (peer && !peer.closed) peer.postMessage({ deck: DECK, index: current }, TARGET);
  }

  // The slide id in the URL, without a new history entry. Some browsers refuse replaceState on
  // pages opened from disk; a fragment navigation does the same there.
  function setHash(id) {
    if (location.hash === "#" + id) return;
    try {
      history.replaceState(null, "", "#" + id);
    } catch (e) {
      location.replace("#" + id);
    }
  }

  function show(n, fromPeer) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    if (n === current) return;
    current = n;
    slides.forEach((s, i) => { s.hidden = i !== n; });
    // A live widget loads the first time its slide is shown, when its frame has a size to fit. The
    // presenter window never loads it: one running copy, on the audience screen.
    if (!isPopup) {
      $$("iframe[data-src]", slides[n]).forEach((frame) => {
        if (!frame.getAttribute("src")) frame.setAttribute("src", frame.dataset.src);
      });
    }
    setHash(slides[n].id);
    status.textContent = `Slide ${n + 1} of ${slides.length}: ${title(slides[n])}`;
    renderPresenter();
    if (!fromPeer) tell();
  }

  const pad = (n) => String(n).padStart(2, "0");
  function tick() {
    const s = Math.floor((Date.now() - started) / 1000);
    elapsedBox.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    const now = new Date();
    clockBox.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  function setPresenter(on) {
    panel.hidden = !on;
    document.body.classList.toggle("is-presenter", on);
    clearInterval(timer);
    timer = 0;
    if (on) {
      started = Date.now();
      tick();
      timer = setInterval(tick, 1000);
    }
    fitAll();
    renderPresenter();
  }

  // S: the presenter view in a new window; with pop-ups blocked, in this window.
  function openPresenter() {
    const url = location.pathname + "?view=presenter#" + slides[current].id;
    const w = window.open(url, "deck-presenter", "popup,width=1280,height=800");
    if (w) peer = w;
    else setPresenter(true);
  }

  // On a live slide, ↓ ↑ and P act on the widget: next or previous example, play or pause. The
  // presenter window passes them to the audience window, which has the running widget.
  const isLive = () => current >= 0 && slides[current].classList.contains("slide--live");
  function liveAction(action) {
    const frame = $("iframe[src]", slides[current]);
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ liveAction: action }, TARGET);
    else if (isPopup && peer && !peer.closed) peer.postMessage({ deck: DECK, liveAction: action }, TARGET);
  }

  // A slide key pressed inside a live widget: the deck takes the keys back from the frame.
  function slideKey(move) {
    if (move === "next") show(current + 1);
    else if (move === "prev") show(current - 1);
    const focused = document.activeElement;
    if (focused && focused.tagName === "IFRAME") focused.blur();
  }

  function fullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => { /* not allowed here */ });
    }
  }

  // Messages: {deck, index} between the two windows; {deck, liveAction} from the presenter window;
  // {deckKey} from a live widget in this page.
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!FROM_DISK && e.origin !== location.origin) return;
    if (!d || typeof d !== "object") return;
    if (d.deckKey === "next" || d.deckKey === "prev") {
      slideKey(d.deckKey);
      return;
    }
    if (d.deck !== DECK) return;
    if (typeof d.liveAction === "string") {
      if (!isPopup) liveAction(d.liveAction);
      return;
    }
    if (!Number.isInteger(d.index)) return;
    if (e.source) peer = e.source;
    show(d.index, true);
  });

  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const onControl = tag === "BUTTON" || tag === "A";
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        if (isLive()) liveAction("next"); else show(current + 1);
        break;
      case "ArrowUp":
        if (isLive()) liveAction("prev"); else show(current - 1);
        break;
      case "p": case "P":
        if (isLive()) liveAction("play"); else handled = false;
        break;
      case "ArrowRight": case "PageDown":
        show(current + 1); break;
      case " ": case "Enter":
        if (onControl) handled = false; else show(current + 1);
        break;
      case "ArrowLeft": case "PageUp": case "Backspace":
        show(current - 1); break;
      case "Home": show(0); break;
      case "End": show(slides.length - 1); break;
      case "f": case "F": fullscreen(); break;
      case "s": case "S":
        if (isPopup) handled = false; else openPresenter();
        break;
      case "n": case "N": setPresenter(panel.hidden); break;
      case "t": case "T":
        if (panel.hidden) { handled = false; } else { started = Date.now(); tick(); }
        break;
      case "+": case "=":
        if (panel.hidden) handled = false; else resizeNotes(2);
        break;
      case "-":
        if (panel.hidden) handled = false; else resizeNotes(-2);
        break;
      case "?": help.hidden = !help.hidden; break;
      case "Escape":
        if (help.hidden) handled = false; else help.hidden = true;
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  panel.addEventListener("click", (e) => {
    const button = e.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "prev") show(current - 1);
    else if (action === "next") show(current + 1);
    else if (action === "reset") { started = Date.now(); tick(); }
    else if (action === "smaller") resizeNotes(-2);
    else if (action === "larger") resizeNotes(2);
  });
  $(".help-close").addEventListener("click", () => { help.hidden = true; });

  // Swipe on touch screens.
  let x0 = null;
  let y0 = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") { x0 = e.clientX; y0 = e.clientY; }
  });
  stage.addEventListener("pointerup", (e) => {
    if (x0 === null) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) show(current + (dx < 0 ? 1 : -1));
  });

  window.addEventListener("resize", fitAll);
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(fitAll);
    ro.observe(stage);
    ro.observe(nextStage);
  }
  window.addEventListener("hashchange", () => show(indexFromHash()));

  applyNotesSize();
  if (isPopup) {
    document.body.classList.add("is-popup");
    peer = window.opener;
    setPresenter(true);
  }
  show(indexFromHash());
  fitAll();
})();
