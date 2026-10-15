// Replay of a real investigation (data/investigation.js): from the Alertmanager webhook to the incident.
(function () {
  "use strict";
  const S = window.Site;
  const D = window.DEMO && window.DEMO.investigation;
  const root = document.getElementById("replay");
  if (!root || !D) return;

  const SPEED = 4; // replay seconds per real second
  const LANES = [
    { id: "alert", label: "Alert → translator" },
    { id: "agent", label: "Triage agent" },
    { id: "llm", label: "LLM turns (router)" },
    { id: "tools", label: "MCP tool calls" },
    { id: "ticket", label: "Ticketing" },
  ];
  const events = D.events;
  const end = Math.max(...events.map((e) => e.offset_s + (e.dur_s || 0)));
  const clock = S.$("#replay-clock", root);
  const btn = S.$("#replay-play", root);
  const list = S.$("#replay-events", root);
  const lanesBox = S.$("#replay-lanes", root);
  const run = S.runner();
  let played = false;
  let shown = -1;

  // ---- lanes (SVG) ----------------------------------------------------------------------
  const W = 960, LEFT = 168, RIGHT = 944, TOP = 26, LH = 44;
  const H = TOP + LANES.length * LH + 30;
  const x = (t) => LEFT + (t / end) * (RIGHT - LEFT);
  const laneY = (id) => TOP + LANES.findIndex((l) => l.id === id) * LH + LH / 2;
  const svg = S.svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Timeline of the investigation by lane" });
  LANES.forEach((l, i) => {
    const y = TOP + i * LH;
    svg.append(S.svgEl("rect", { x: 0, y: y + 2, width: W, height: LH - 4, rx: 8, class: `lane-bg ${i % 2 ? "b" : "a"}` }));
    svg.append(S.svgEl("text", { x: 14, y: y + LH / 2 + 4, class: "lane-label", text: l.label }));
  });
  for (let s = 0; s <= end; s += 10) {
    svg.append(S.svgEl("line", { x1: x(s), x2: x(s), y1: TOP, y2: H - 24, class: "tick-line" }));
    svg.append(S.svgEl("text", { x: x(s), y: H - 8, "text-anchor": "middle", class: "tick-text", text: `T+${s}s` }));
  }
  const marks = events.map((e) => {
    const y = laneY(e.lane);
    let node;
    if (e.lane === "llm") {
      const kind = e.routed_to === "sota-smart" ? "sota" : "local";
      node = S.svgEl("rect", { x: x(e.offset_s), y: y - 11, width: 0, height: 22, rx: 4, class: `mark-llm ${kind}`, opacity: 0.9 });
      node.dataset.w = Math.max(3, x(e.offset_s + e.dur_s) - x(e.offset_s));
      node.append(S.svgEl("title", { text: `${e.title}: ${e.routed_to === "sota-smart" ? "SOTA" : "LOCAL"} (${e.decided_by}), ${S.fmtSecs(e.dur_s)}` }));
    } else if (e.lane === "tools") {
      node = S.svgEl("circle", { cx: x(e.offset_s), cy: y, r: 6, class: "mark-tool", opacity: 0 });
      node.append(S.svgEl("title", { text: `${e.title} (${e.detail})` }));
    } else {
      const cls = e.kind === "incident" ? "mark-incident" : "mark-event";
      node = S.svgEl("path", { d: `M ${x(e.offset_s)} ${y - 10} l 8 10 l -8 10 l -8 -10 z`, class: cls, opacity: 0 });
      node.append(S.svgEl("title", { text: e.title }));
    }
    svg.append(node);
    return node;
  });
  const head = S.svgEl("line", { x1: LEFT, x2: LEFT, y1: TOP - 6, y2: H - 22, class: "playhead" });
  svg.append(head);
  lanesBox.replaceChildren(svg);

  // ---- event list -----------------------------------------------------------------------
  const items = events.map((e) => {
    let detail = e.detail || "";
    if (e.lane === "llm") {
      const where = e.routed_to === "sota-smart" ? "external SOTA model" : "local GPU model";
      const tokens = Number.isFinite(e.tokens_in) && Number.isFinite(e.tokens_out)
        ? ` · ${e.tokens_in.toLocaleString("en-US")} tokens in, ${e.tokens_out.toLocaleString("en-US")} out` : "";
      detail = `${where}, decided by the ${e.decided_by} gate · ${S.fmtSecs(e.dur_s)}${tokens}`;
    } else if (e.lane === "tools") {
      detail = `${e.detail} · ${Math.round(e.dur_s * 1000)} ms`;
    }
    const li = S.el("li", {}, [
      S.el("span", { class: "t", text: `+${e.offset_s.toFixed(1)}s` }),
      S.el("span", {}, [S.el("span", { class: "what", text: e.title }), S.el("br"), S.el("span", { class: "detail", text: detail })]),
    ]);
    if (e.lane === "llm") li.title = e.reason;
    list.append(li);
    return li;
  });

  function render(t) {
    head.setAttribute("x1", x(t)); head.setAttribute("x2", x(t));
    clock.textContent = `T+${t.toFixed(1)} s`;
    let last = -1;
    events.forEach((e, i) => {
      const on = e.offset_s <= t;
      items[i].classList.toggle("on", on);
      if (on) last = i;
      const m = marks[i];
      if (e.lane === "llm") m.setAttribute("width", on ? Math.min(+m.dataset.w, x(t) - x(e.offset_s)) : 0);
      else m.setAttribute("opacity", on ? 1 : 0);
    });
    items.forEach((li, i) => li.classList.toggle("now", i === last));
    if (last !== shown) { shown = last; keepInView(items[last]); }
  }

  // Scroll the event list (not the page) so that the current event stays visible.
  function keepInView(li) {
    if (!li) return;
    const top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, bottom - list.clientHeight + 8), behavior: S.reducedMotion() ? "auto" : "smooth" });
    }
  }

  function play() {
    played = true;
    const alive = run.next();
    btn.textContent = "Replay";
    if (S.reducedMotion()) { render(end); return; }
    let t0 = null;
    (function frame(ts) {
      if (!alive()) return;
      if (t0 === null) t0 = ts;
      const t = Math.min(end, ((ts - t0) / 1000) * SPEED);
      render(t);
      if (t < end) requestAnimationFrame(frame);
    })(performance.now());
  }

  btn.addEventListener("click", play);
  const inc = D.incident;
  S.$("#replay-title").textContent = `Namespace ${D.namespace} (${D.data_class}): from the alert to incident ${inc.number} in ${Math.round(events.find((e) => e.kind === "incident").offset_s)} seconds`;
  S.$("#replay-meta").textContent = `Captured on ${D.captured_at} from a demo cluster. ${D.notes.join(" ")} Speed ×${SPEED}.`;
  render(S.reducedMotion() ? end : 0);
  S.onVisible(root, (v) => { if (v && !played) play(); });
})();
