// Routing simulator: replays real decisions of the router (data/scenarios.js) through its gates.
(function () {
  "use strict";
  const S = window.Site;
  const D = window.DEMO && window.DEMO.scenarios;
  const root = document.getElementById("sim");
  if (!root || !D) return;

  const COLORS = { start: "#e0e0e0", local: "#34d3b8", sota: "#f4b04a", restricted: "#ff6670" };
  const chipsBox = S.$(".chips", root);
  const stage = S.$(".stage", root);
  const reqBox = S.$("#sim-request", root);
  const logBox = S.$("#sim-log", root);
  const playBtn = S.$("#sim-play", root);
  const scenarios = D.scenarios;
  const gates = D.gates;
  const run = S.runner();
  let cur = 0;
  let auto = !S.reducedMotion();
  let visible = false;
  let narrow = null;
  let L = null; // current layout
  let svg = null;

  // ---- layout ---------------------------------------------------------------------------
  function wrapWords(text, max) {
    const lines = [];
    let line = "";
    for (const w of text.split(" ")) {
      if ((line + " " + w).trim().length > max && line) { lines.push(line); line = w; } else line = (line + " " + w).trim();
    }
    if (line) lines.push(line);
    return lines;
  }

  function layoutWide() {
    const gx = [208, 350, 492, 634];
    const g = gx.map((x) => ({ x, y: 92, w: 124, h: 82, cx: x + 62, cy: 133 }));
    return {
      w: 960, h: 372, narrow: false, qmax: 21,
      zones: [
        { x: 178, y: 14, w: 618, h: 346, label: "OPENSHIFT CLUSTER", lx: 194, ly: 34 },
        { x: 806, y: 14, w: 146, h: 346, label: "OUTSIDE", lx: 822, ly: 34 },
      ],
      request: { x: 14, y: 96, w: 146, h: 74 },
      gates: g,
      local: { x: 292, y: 280, w: 396, h: 62, title: "Local GPU model", sub: "Qwen3.8 27B on vLLM · the data stays here" },
      sota: { x: 818, y: 96, w: 124, h: 74, title: "External model", sub: ["Gemini 2.5 Pro", "SOTA, outside"] },
      wire: "M 160 133 L 818 133",
      seg: (i) => `M ${i === 0 ? 160 : g[i - 1].cx} 133 L ${g[i].cx} 133`,
      drop: (i) => `M ${g[i].cx} 133 L ${g[i].cx} 174 C ${g[i].cx} 236, 490 222, 490 280`,
      dropWire: (i) => `M ${g[i].cx} 174 C ${g[i].cx} 236, 490 222, 490 280`,
      toSota: `M ${g[3].cx} 133 L 818 133`,
    };
  }

  function layoutNarrow() {
    const gy = [104, 186, 268, 350];
    const g = gy.map((y) => ({ x: 16, y, w: 196, h: 66, cx: 114, cy: y + 33 }));
    return {
      w: 360, h: 560, narrow: true, qmax: 31,
      zones: [
        { x: 6, y: 86, w: 348, h: 350, label: "OPENSHIFT CLUSTER", lx: 18, ly: 98 },
        { x: 6, y: 446, w: 348, h: 106, label: "OUTSIDE", lx: 18, ly: 462 },
      ],
      request: { x: 16, y: 10, w: 196, h: 60 },
      gates: g,
      local: { x: 236, y: 186, w: 110, h: 148, title: "Local GPU", sub: ["Qwen3.8 27B", "on vLLM", "data stays", "here"] },
      sota: { x: 16, y: 474, w: 196, h: 60, title: "External model", sub: ["Gemini 2.5 Pro (SOTA)"] },
      wire: "M 114 70 L 114 474",
      seg: (i) => `M 114 ${i === 0 ? 70 : g[i - 1].cy} L 114 ${g[i].cy}`,
      drop: (i) => `M 114 ${g[i].cy} L 212 ${g[i].cy} C 226 ${g[i].cy}, 222 260, 236 260`,
      dropWire: (i) => `M 212 ${g[i].cy} C 226 ${g[i].cy}, 222 260, 236 260`,
      toSota: `M 114 ${g[3].cy} L 114 474`,
    };
  }

  function box(cls, b, title, subs, extra) {
    const grp = S.svgEl("g", Object.assign({ class: cls }, extra || {}));
    grp.append(S.svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }));
    const lines = [].concat(subs || []);
    const top = b.y + b.h / 2 - (lines.length * 13) / 2 + 2;
    grp.append(S.svgEl("text", { x: b.x + b.w / 2, y: top, "text-anchor": "middle", class: "title", fill: "#ffffff", "font-weight": 600, "font-size": 14, text: title }));
    lines.forEach((t, i) => grp.append(S.svgEl("text", { x: b.x + b.w / 2, y: top + 16 + i * 13, "text-anchor": "middle", class: "q", fill: "#a3a3a3", "font-size": 11, text: t })));
    return grp;
  }

  function draw() {
    const isNarrow = window.matchMedia("(max-width: 640px)").matches;
    if (isNarrow === narrow && svg) return false;
    narrow = isNarrow;
    run.stop();
    L = narrow ? layoutNarrow() : layoutWide();
    svg = S.svgEl("svg", { viewBox: `0 0 ${L.w} ${L.h}`, role: "img", "aria-label": "The four gates of the router between a request and the two models" });
    for (const z of L.zones) {
      svg.append(S.svgEl("rect", { class: "zone", x: z.x, y: z.y, width: z.w, height: z.h, rx: 14 }));
      svg.append(S.svgEl("text", { class: "zone-label", x: z.lx, y: z.ly, text: z.label }));
    }
    svg.append(S.svgEl("path", { class: "wire", d: L.wire }));
    L.gates.forEach((g, i) => svg.append(S.svgEl("path", { class: "wire drop", d: L.dropWire(i) })));
    svg.append(box("dest req", L.request, "Request", [], { id: "sim-req-box" }));
    L.reqSub = S.svgEl("text", { x: L.request.x + L.request.w / 2, y: L.request.y + L.request.h / 2 + 17, "text-anchor": "middle", fill: "#a3a3a3", "font-size": 11 });
    svg.append(L.reqSub);
    L.gateNodes = gates.map((gd, i) => {
      const n = box("gate", L.gates[i], `${i + 1} · ${gd.title}`, wrapWords(gd.question, L.qmax));
      svg.append(n);
      return n;
    });
    L.localNode = box("dest local", L.local, L.local.title, [].concat(L.local.sub));
    L.sotaNode = box("dest sota", L.sota, L.sota.title, L.sota.sub);
    svg.append(L.localNode, L.sotaNode);
    stage.replaceChildren(svg);
    show(cur, !auto || !visible);
    return true;
  }

  // ---- panels ---------------------------------------------------------------------------
  const VERDICT = { pass: "pass", sota: "go on", local: "LOCAL" };

  function logLines(sc) {
    const lines = [{ cls: "head", text: `[policy-router] team=${sc.request.team}` }];
    gates.forEach((g) => {
      const st = sc.steps.find((s) => s.gate === g.id);
      if (st) {
        const kind = st.verdict === "local" ? (g.id === "namespace" ? "restricted" : "local") : "";
        lines.push({ gate: g.id, cls: kind, text: `${st.reason}${st.reason.includes("->") ? "" : "  [" + VERDICT[st.verdict] + "]"}` });
      } else if (g.id === "tiering" && sc.decided_by === "all-sota") {
        lines.push({ gate: g.id, cls: "", text: "tiering: no change  [pass]" });
      }
    });
    const dest = D.destinations[sc.routed_to];
    lines.push({
      gate: "final", cls: sc.routed_to === "sota-smart" ? "sota" : "local",
      text: `routed_to=${sc.routed_to}  decided_by=${sc.decided_by}  ->  ${dest.label} (${S.fmtMs(sc.duration_ms)} in the router and model)`,
    });
    return lines;
  }

  function renderPanels(sc, lit) {
    const r = sc.request;
    const meta = [`Sent by ${r.who}`, r.prompt_chars ? `${r.prompt_chars.toLocaleString("en-US")} characters` : null, r.case ? `validation case ${r.case}` : null]
      .filter(Boolean).join(" · ");
    reqBox.replaceChildren(
      S.el("p", { class: "panel-title", text: "Request" }),
      S.el("p", { class: "request-text" }, r.text ? [S.el("q", { text: r.text })] : [r.summary]),
      S.el("p", { class: "request-meta", text: meta }),
    );
    const pre = S.el("pre", { class: "log", "aria-live": "polite" });
    for (const l of logLines(sc)) {
      pre.append(S.el("span", { class: `ln ${l.cls}${lit === true || l.cls === "head" ? " on" : ""}`, "data-gate": l.gate || "", text: l.text }));
    }
    logBox.replaceChildren(S.el("p", { class: "panel-title", text: "Decision of the router (real log)" }), pre);
    if (L) L.reqSub.textContent = r.team.length > 22 ? r.team.slice(0, 21) + "…" : r.team;
  }

  function light(gateId) {
    const ln = S.$(`.ln[data-gate="${gateId}"]`, logBox);
    if (ln) ln.classList.add("on");
  }

  function resetVisuals() {
    for (const n of L.gateNodes) n.setAttribute("class", "gate");
    L.localNode.setAttribute("class", "dest local");
    L.sotaNode.setAttribute("class", "dest sota");
  }

  function decidingIndex(sc) {
    return gates.findIndex((g) => g.id === sc.decided_by);
  }

  function markGate(sc, i, decides) {
    const g = gates[i];
    let cls = "gate pass";
    if (decides) cls = g.id === "namespace" ? "gate restricted" : "gate local";
    L.gateNodes[i].setAttribute("class", cls);
    light(g.id);
  }

  // Final state without animation (reduced motion, or a static view).
  function showStatic(sc) {
    resetVisuals();
    const d = decidingIndex(sc);
    const last = d >= 0 ? d : gates.length - 1;
    for (let i = 0; i <= last; i++) markGate(sc, i, i === d);
    (sc.routed_to === "sota-smart" ? L.sotaNode : L.localNode).classList.add("hit");
    light("final");
  }

  function selectChip(i) {
    S.$$(".chip", chipsBox).forEach((c, k) => c.setAttribute("aria-pressed", k === i ? "true" : "false"));
  }

  function show(i, staticView) {
    cur = (i + scenarios.length) % scenarios.length;
    selectChip(cur);
    renderPanels(scenarios[cur], staticView);
    resetVisuals();
    if (staticView) showStatic(scenarios[cur]);
  }

  // ---- animation ------------------------------------------------------------------------
  async function play(sc, alive) {
    renderPanels(sc, false);
    resetVisuals();
    const d = decidingIndex(sc);
    const last = d >= 0 ? d : gates.length - 1;
    for (let i = 0; i <= last; i++) {
      if (!(await S.travel(svg, L.seg(i), COLORS.start, 620, alive))) return false;
      markGate(sc, i, i === d);
      if (!(await S.wait(260, alive))) return false;
    }
    if (d >= 0) {
      const color = gates[d].id === "namespace" ? COLORS.restricted : COLORS.local;
      if (!(await S.travel(svg, L.drop(d), color, 900, alive))) return false;
      L.localNode.classList.add("hit");
    } else {
      if (!(await S.travel(svg, L.toSota, COLORS.sota, 760, alive))) return false;
      L.sotaNode.classList.add("hit");
    }
    light("final");
    return S.wait(2800, alive);
  }

  async function loop(once) {
    const alive = run.next();
    while (alive()) {
      if (!visible) { if (!(await S.wait(300, alive))) return; continue; }
      if (!(await play(scenarios[cur], alive))) return;
      if (once || !auto) return;
      show(cur + 1, false);
    }
  }

  function pick(i) {
    show(i, S.reducedMotion());
    S.setHashParam("sim", scenarios[cur].id);
    if (!S.reducedMotion()) loop(!auto);
  }

  function setAuto(on) {
    auto = on && !S.reducedMotion();
    playBtn.textContent = auto ? "Pause" : "Play all";
    playBtn.setAttribute("aria-pressed", auto ? "true" : "false");
    if (auto) loop(false); else run.stop();
  }

  // ---- wiring ---------------------------------------------------------------------------
  scenarios.forEach((sc, i) => {
    const color = sc.routed_to === "sota-smart" ? COLORS.sota : sc.decided_by === "namespace" ? COLORS.restricted : COLORS.local;
    const chip = S.el("button", { class: "chip", type: "button", "aria-pressed": "false" }, [
      S.el("span", { class: "dot", style: `background:${color}` }), sc.label,
    ]);
    chip.addEventListener("click", () => pick(i));
    chipsBox.append(chip);
  });
  S.$("#sim-prev", root).addEventListener("click", () => pick(cur - 1));
  S.$("#sim-next", root).addEventListener("click", () => pick(cur + 1));
  playBtn.addEventListener("click", () => setAuto(!auto));
  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); pick(cur + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); pick(cur - 1); }
  });
  // Presenter keys: N and P change the scenario while the simulator is on screen.
  document.addEventListener("keydown", (e) => {
    if (!visible || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "n" || e.key === "N") pick(cur + 1);
    if (e.key === "p" || e.key === "P") pick(cur - 1);
  });

  const fromHash = S.hashParam("sim");
  const start = Math.max(0, scenarios.findIndex((s) => s.id === fromHash));
  cur = start;
  draw();
  window.addEventListener("resize", () => { if (draw() && auto) loop(false); });
  S.$("#sim-meta").textContent = `Captured on ${D.captured_at} from a demo cluster, router ${D.router_version}.`;
  if (fromHash) document.getElementById("routing").scrollIntoView();
  setAuto(auto);
  S.onVisible(stage, (v) => { visible = v; });
})();
