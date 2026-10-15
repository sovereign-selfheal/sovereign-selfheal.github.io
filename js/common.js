// Shared helpers of the site. No dependencies, nothing loaded from other sites.
(function () {
  "use strict";
  const SVG_NS = "http://www.w3.org/2000/svg";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // Create an element: el("div", {class: "x"}, ["text", child]). svg: true for SVG elements.
  function make(ns, tag, attrs, children) {
    const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }
  const el = (tag, attrs, children) => make(null, tag, attrs, children);
  const svgEl = (tag, attrs, children) => make(SVG_NS, tag, attrs, children);

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

  // A run of an animation. A new run cancels the old one; every step checks alive().
  function runner() {
    let id = 0;
    return {
      next() { id += 1; const mine = id; return () => mine === id; },
      stop() { id += 1; },
    };
  }

  // Wait ms, unless the run ends first. Resolves to true when the run is still alive.
  function wait(ms, alive) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      (function tick() {
        if (!alive()) return resolve(false);
        if (performance.now() - t0 >= ms) return resolve(true);
        setTimeout(tick, Math.min(100, ms));
      })();
    });
  }

  // Move a glowing dot along the SVG path data d in ms milliseconds.
  function travel(svg, d, color, ms, alive) {
    return new Promise((resolve) => {
      const path = svgEl("path", { d, fill: "none", stroke: "none" });
      const halo = svgEl("circle", { r: 13, fill: color, opacity: 0.22 });
      const dot = svgEl("circle", { r: 6.5, fill: color });
      svg.append(path, halo, dot);
      const len = path.getTotalLength();
      let start = null;
      const done = (ok) => { path.remove(); halo.remove(); dot.remove(); resolve(ok); };
      function frame(ts) {
        if (!alive()) return done(false);
        if (start === null) start = ts;
        const p = Math.min(1, (ts - start) / ms);
        const pt = path.getPointAtLength(len * ease(p));
        for (const c of [halo, dot]) { c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y); }
        if (p < 1) requestAnimationFrame(frame); else done(true);
      }
      requestAnimationFrame(frame);
    });
  }

  // Call cb(true) when the element is on screen and the tab is visible, cb(false) otherwise.
  function onVisible(node, cb) {
    let seen = false;
    const report = () => cb(seen && !document.hidden);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => { seen = entries[entries.length - 1].isIntersecting; report(); }, { threshold: 0.2 }).observe(node);
    } else { seen = true; }
    document.addEventListener("visibilitychange", report);
    report();
  }

  // Read and write a deep link like #sim=privacy.
  function hashParam(name) {
    const m = new RegExp("(?:^#|&)" + name + "=([^&]+)").exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setHashParam(name, value) {
    const url = "#" + name + "=" + encodeURIComponent(value);
    if (location.hash !== url) history.replaceState(null, "", url);
  }

  const fmtSecs = (s) => (s < 10 ? s.toFixed(2) : s < 100 ? s.toFixed(1) : Math.round(s).toString()) + " s";
  const fmtMs = (ms) => (ms < 1 ? ms.toFixed(2) + " ms" : ms < 1000 ? ms.toFixed(1) + " ms" : (ms / 1000).toFixed(2) + " s");
  const utc = (iso) => iso.slice(11, 19) + " UTC";

  window.Site = { $, $$, el, svgEl, reducedMotion, runner, wait, travel, onVisible, hashParam, setHashParam, fmtSecs, fmtMs, utc };

  // Highlight the section of the menu that is on screen.
  document.addEventListener("DOMContentLoaded", () => {
    const links = $$(".top nav a[href^='#']");
    const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    if (!("IntersectionObserver" in window) || map.size === 0) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.removeAttribute("aria-current"));
        const a = map.get(e.target.id);
        if (a) a.setAttribute("aria-current", "page");
      }
    }, { rootMargin: "-40% 0px -55% 0px" });
    for (const id of map.keys()) { const s = document.getElementById(id); if (s) io.observe(s); }
  });
})();
