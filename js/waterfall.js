// Trace waterfall: real router traces from Tempo (data/traces.js), drawn like a trace viewer.
(function () {
  "use strict";
  const S = window.Site;
  const D = window.DEMO && window.DEMO.traces;
  const root = document.getElementById("waterfall");
  if (!root || !D) return;

  const ABOUT = {
    "Received Proxy Server Request": "The request reaches LiteLLM, the router of the platform.",
    proxy_pre_call: "Work before the model call; ChainRouter is the policy hook.",
    "router.chain": "The routing decision. The first gate that says LOCAL decides.",
    "gate.namespace": "Gate 1: a request about a restricted namespace stays local.",
    "gate.efficiency": "Gate 2: short, too large or over-budget requests stay local.",
    "gate.privacy": "Gate 3: rules, lexicons and the decision model look for sensitive data.",
    router: "LiteLLM picks a deployment of the chosen model alias.",
    litellm_request: "The call to the chosen model. Prompt and answer were removed from this copy.",
    raw_gen_ai_request: "The raw call to the model server.",
    self: "Time of the HTTP call to the model server (for a streamed answer, until the stream starts).",
  };

  const tabs = S.$(".tabs", root);
  const table = S.$("#wf-table", root);
  const attrs = S.$("#wf-attrs", root);
  let shown = false;

  function depthOf(spans) {
    const by = new Map(spans.map((s) => [s.id, s]));
    const depth = (s) => (s.parent && by.has(s.parent) ? 1 + depth(by.get(s.parent)) : 0);
    return new Map(spans.map((s) => [s.id, depth(s)]));
  }

  function barClass(s) {
    if (s.name === "router.chain") return "chain";
    if (s.name.startsWith("gate.")) {
      const v = s.attrs["gate.verdict"];
      if (v === "local") return s.name === "gate.namespace" ? "restricted" : "local";
      return "chain";
    }
    const model = s.attrs["gen_ai.request.model"] || s.attrs["llm.openai.model"] || s.attrs["litellm.model_group"] || "";
    if (/gemini|sota/i.test(model)) return "sota";
    if (/qwen|local/i.test(model)) return "local";
    return "";
  }

  function showAttrs(s) {
    const dl = S.el("dl");
    const rows = Object.entries(s.attrs);
    for (const [k, v] of rows) dl.append(S.el("dt", { text: k }), S.el("dd", { text: String(v) }));
    if (!rows.length) dl.append(S.el("dt", { text: "(none)" }), S.el("dd", { text: "no attribute kept for this span" }));
    attrs.replaceChildren(
      S.el("p", { class: "panel-title", text: `${s.name} · ${S.fmtMs(s.dur_ms)}` }),
      S.el("p", { class: "request-meta", text: ABOUT[s.name] || "" }),
      dl,
    );
  }

  function render(i) {
    const tr = D.traces[i];
    S.$$(".chip", tabs).forEach((c, k) => c.setAttribute("aria-pressed", k === i ? "true" : "false"));
    const depth = depthOf(tr.spans);
    const total = tr.duration_ms;
    const tbody = S.el("tbody");
    let first = null;
    tr.spans.forEach((s) => {
      const left = (s.start_ms / total) * 100;
      const width = Math.max(0.3, (s.dur_ms / total) * 100);
      const bar = S.el("div", { class: `bar ${barClass(s)}`, style: `left:${left}%;width:${width}%;transform:scaleX(${shown || S.reducedMotion() ? 1 : 0})` });
      const row = S.el("tr", { class: "span", tabindex: "0" }, [
        S.el("td", { class: "name", style: `padding-left:${8 + depth.get(s.id) * 16}px`, text: s.name }),
        S.el("td", { class: "bar-cell" }, [S.el("div", { class: "track" }, [bar])]),
        S.el("td", { class: "dur", text: S.fmtMs(s.dur_ms) }),
      ]);
      const select = () => { S.$$("tr.span", tbody).forEach((r) => r.classList.remove("sel")); row.classList.add("sel"); showAttrs(s); };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(); } });
      tbody.append(row);
      if (s.name === "router.chain") first = select;
    });
    table.replaceChildren(
      S.el("thead", {}, [S.el("tr", {}, [S.el("th", { text: "Span" }), S.el("th", { text: `Timeline (${S.fmtMs(total)})` }), S.el("th", { text: "Duration" })])]),
      tbody,
    );
    if (first) first();
    S.$("#wf-meta").textContent = `Trace ${tr.trace_id}, ${tr.started.slice(0, 10)} ${S.utc(tr.started)}, router ${D.router_version}. Only an allowlist of attributes was kept: no prompt, no answer, no address.`;
  }

  D.traces.forEach((tr, i) => {
    const b = S.el("button", { class: "chip", type: "button", "aria-pressed": "false", text: tr.label });
    b.addEventListener("click", () => render(i));
    tabs.append(b);
  });
  render(0);
  S.onVisible(root, (v) => {
    if (!v || shown) return;
    shown = true;
    S.$$(".bar", root).forEach((b, k) => setTimeout(() => { b.style.transform = "scaleX(1)"; }, 60 * k));
  });
})();
