// Architecture map (data/components.js): hover or focus a component to read what it does.
(function () {
  "use strict";
  const S = window.Site;
  const D = window.DEMO && window.DEMO.components;
  const root = document.getElementById("map");
  if (!root || !D) return;

  const ORG = "https://github.com/sovereign-selfheal/";
  const box = S.$("#map-svg", root);
  const info = S.$("#map-info", root);
  const listBox = S.$("#map-list", root);
  const byId = new Map(D.components.map((c) => [c.id, c]));

  function anchors(a, b, side) {
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    if (side === "left") {
      const s = { x: a.x, y: ac.y }, t = { x: b.x, y: bc.y };
      return `M ${s.x} ${s.y} C ${s.x - 20} ${s.y}, ${t.x - 20} ${t.y}, ${t.x} ${t.y}`;
    }
    const dx = bc.x - ac.x, dy = bc.y - ac.y;
    if (Math.abs(dx) > Math.abs(dy) * 0.6 && (b.x >= a.x + a.w || b.x + b.w <= a.x)) {
      const s = { x: dx > 0 ? a.x + a.w : a.x, y: ac.y }, t = { x: dx > 0 ? b.x : b.x + b.w, y: bc.y };
      const mx = (s.x + t.x) / 2;
      return `M ${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${t.y}, ${t.x} ${t.y}`;
    }
    const s = { x: ac.x, y: dy > 0 ? a.y + a.h : a.y }, t = { x: bc.x, y: dy > 0 ? b.y : b.y + b.h };
    const my = (s.y + t.y) / 2;
    return `M ${s.x} ${s.y} C ${s.x} ${my}, ${t.x} ${my}, ${t.x} ${t.y}`;
  }

  function repoLink(c) {
    return c.repo
      ? S.el("a", { href: ORG + c.repo, text: `github.com/sovereign-selfheal/${c.repo}` })
      : S.el("span", { class: "tag muted", text: "external service" });
  }

  function showInfo(c) {
    const tags = [];
    if (c.kind === "preview") tags.push(S.el("span", { class: "tag preview", text: "PREVIEW" }), " ");
    if (c.kind === "external") tags.push(S.el("span", { class: "tag sota", text: "OUTSIDE THE CLUSTER" }), " ");
    if (/restricted/.test(c.sub)) tags.push(S.el("span", { class: "tag restricted", text: "RESTRICTED" }), " ");
    info.replaceChildren(
      S.el("h3", { text: c.name }),
      S.el("p", { class: "request-meta" }, [...tags, c.sub]),
      S.el("p", { text: c.summary }),
      S.el("p", {}, [repoLink(c)]),
    );
  }

  const svg = S.svgEl("svg", { viewBox: "0 0 960 560", role: "group", "aria-label": "Architecture of the demo" });
  for (const z of D.zones) {
    svg.append(S.svgEl("rect", { class: "map-zone", x: z.x, y: z.y, width: z.w, height: z.h, rx: 12 }));
    svg.append(S.svgEl("text", { class: "map-zone-label", x: z.x + 12, y: z.y - 8 + (z.id === "platform" ? 22 : 0), text: z.label }));
  }
  const edgeNodes = D.edges.map((e) => {
    const p = S.svgEl("path", { class: "edge", d: anchors(byId.get(e.from), byId.get(e.to), e.side) });
    svg.append(p);
    return { e, p };
  });
  const nodes = D.components.map((c) => {
    const g = S.svgEl("g", { class: `node ${c.kind}`, tabindex: "0", role: "button", "aria-label": `${c.name}: ${c.sub}` });
    g.append(S.svgEl("rect", { x: c.x, y: c.y, width: c.w, height: c.h, rx: 9 }));
    g.append(S.svgEl("text", { x: c.x + 10, y: c.y + c.h / 2 - 3, text: c.name }));
    g.append(S.svgEl("text", { class: "sub", x: c.x + 10, y: c.y + c.h / 2 + 12, text: c.sub }));
    const activate = () => {
      nodes.forEach((n) => n.g.classList.remove("sel"));
      g.classList.add("sel");
      edgeNodes.forEach(({ e, p }) => p.classList.toggle("hot", e.from === c.id || e.to === c.id));
      showInfo(c);
    };
    g.addEventListener("mouseenter", activate);
    g.addEventListener("focus", activate);
    g.addEventListener("click", activate);
    svg.append(g);
    return { c, g, activate };
  });
  box.replaceChildren(svg);
  nodes.find((n) => n.c.id === "router").activate();

  // Small screens: the same content as a list.
  for (const z of D.zones) {
    const ul = S.el("ul");
    for (const c of D.components.filter((k) => k.zone === z.id)) {
      ul.append(S.el("li", {}, [S.el("b", { text: c.name }), ` (${c.sub}): ${c.summary} `, repoLink(c)]));
    }
    listBox.append(S.el("h3", { text: z.label.charAt(0) + z.label.slice(1).toLowerCase() }), ul);
  }
})();
