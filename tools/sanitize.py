"""Build the data files of the site (data/*.js) from a raw capture of a demo cluster.

The raw capture (see capture.py) holds router logs, agent logs, Tempo traces and the incident list.
They contain prompts, answers, IP addresses and host names, so this script copies only the fields
it knows (allowlists). Nothing else reaches the site.

    uv run --project tools python tools/sanitize.py --raw <capture dir> --validation <validation repo>
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import yaml

from leaks import leaks

ROOT = Path(__file__).resolve().parent.parent

GATES = [
    {"id": "namespace", "title": "Namespace", "question": "Is it about a restricted namespace?"},
    {"id": "efficiency", "title": "Efficiency", "question": "Does it need the external model?"},
    {"id": "privacy", "title": "Privacy", "question": "Is there sensitive data?"},
    {"id": "tiering", "title": "Tiering", "question": "May this team use the external model?"},
]

DESTINATIONS = {
    "local-fast": {"label": "Local GPU model", "model": "Qwen3.8 27B (NVFP4) on vLLM, in the cluster"},
    "sota-smart": {"label": "External SOTA model", "model": "Gemini 2.5 Pro, outside the cluster"},
}

# Buggy-app instance of each monitored namespace: gitops components/observability/values.yaml,
# alerts.quarkusBuggyApp.services (one Service per namespace since gitops #52).
BUGGY_APPS = {
    "payments": "payments-buggy-app",
    "rh-reserve": "rh-reserve-buggy-app",
    "reverse-proxy-app": "reverse-proxy-buggy-app",
}

# Span attributes that may reach the site, by span name (prefix match for gate.*).
SPAN_ATTRS = {
    "Received Proxy Server Request": ["http.route", "http.response.status_code"],
    "proxy_pre_call": ["call_type"],
    "router": ["call_type"],
    "self": ["call_type"],
    "raw_gen_ai_request": ["llm.openai.model"],
    "litellm_request": [
        "litellm.model_group",
        "gen_ai.request.model",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "llm.is_streaming",
    ],
    "router.chain": ["route.requested", "route.target", "route.decided_by", "route.team", "route.reason"],
    "gate.": [
        "gate.verdict",
        "gate.reason",
        "privacy.score",
        "privacy.threshold",
        "privacy.team_key",
        "privacy.signals",
        "classifier.backend",
        "classifier.fallback",
    ],
    "presidio.analyze": ["presidio.language", "presidio.entities_found"],
}



def attr_value(v: dict):
    """The value of an OTLP attribute. OTLP JSON encodes int64 values as strings."""
    if "intValue" in v:
        return int(v["intValue"])
    for key in ("stringValue", "doubleValue", "boolValue"):
        if key in v:
            return v[key]
    return None


def load_trace(path: Path) -> list[dict]:
    """All spans of a Tempo trace, with plain attribute dicts."""
    data = json.loads(path.read_text())
    spans = []
    for batch in data.get("batches", []):
        service = next(
            (attr_value(a["value"]) for a in batch["resource"]["attributes"] if a["key"] == "service.name"), "-"
        )
        for scope in batch.get("scopeSpans", []):
            for s in scope.get("spans", []):
                spans.append(
                    {
                        "id": s["spanId"],
                        "parent": s.get("parentSpanId", ""),
                        "name": s["name"],
                        "service": service,
                        "start": int(s["startTimeUnixNano"]),
                        "end": int(s["endTimeUnixNano"]),
                        "attrs": {a["key"]: attr_value(a["value"]) for a in s.get("attributes", [])},
                    }
                )
    return spans


def allowed_attrs(name: str, attrs: dict) -> dict:
    keys = SPAN_ATTRS.get(name) or (SPAN_ATTRS["gate."] if name.startswith("gate.") else [])
    out = {k: attrs[k] for k in keys if k in attrs and attrs[k] not in (None, "")}
    for k, v in out.items():
        if isinstance(v, str) and v.startswith("chain: fail-closed"):
            out[k] = "chain: fail-closed (details removed)"
    return out


def iso(ns: int) -> str:
    return datetime.fromtimestamp(ns / 1e9, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def decision_from_trace(spans: list[dict]) -> dict:
    """The routing decision of a request: the router.chain span and its gate.* children."""
    chain = next(s for s in spans if s["name"] == "router.chain")
    a = chain["attrs"]
    steps = []
    order = {g["id"]: i for i, g in enumerate(GATES)}
    for s in sorted((s for s in spans if s["name"].startswith("gate.")), key=lambda s: order.get(s["name"][5:], 9)):
        steps.append(
            {
                "gate": s["name"][5:],
                "verdict": s["attrs"].get("gate.verdict", ""),
                "reason": s["attrs"].get("gate.reason", ""),
            }
        )
    if a.get("route.decided_by") == "tiering":
        steps.append({"gate": "tiering", "verdict": "local", "reason": a.get("route.reason", "")})
    llm = next((s for s in spans if s["name"] == "litellm_request"), None)
    root = next((s for s in spans if s["name"] == "Received Proxy Server Request"), chain)
    return {
        "routed_to": a.get("route.target"),
        "decided_by": a.get("route.decided_by"),
        "team": a.get("route.team"),
        "reason": a.get("route.reason"),
        "steps": steps,
        "model": (llm or {}).get("attrs", {}).get("gen_ai.request.model"),
        "tokens_in": (llm or {}).get("attrs", {}).get("gen_ai.usage.input_tokens"),
        "tokens_out": (llm or {}).get("attrs", {}).get("gen_ai.usage.output_tokens"),
        "duration_ms": round((root["end"] - root["start"]) / 1e6, 1),
        "ts": iso(chain["start"]),
    }


def router_lines(raw: Path) -> dict[str, dict]:
    """[policy-router] decisions by trace id (only the fields the site shows)."""
    out = {}
    for log in sorted(raw.glob("raw/litellm-*.log")):
        for line in log.read_text(errors="replace").splitlines():
            if "[policy-router] {" not in line:
                continue
            try:
                d = ast.literal_eval(line.split("[policy-router] ", 1)[1].strip())
            except (ValueError, SyntaxError):
                continue
            if d.get("trace_id"):
                out[d["trace_id"]] = {"prompt_chars": d.get("prompt_chars")}
    return out


def validation_prompts(validation: Path) -> dict[str, dict]:
    cases = yaml.safe_load((validation / "cases/routing.yml").read_text())
    access = yaml.safe_load((validation / "roles/validate_router/defaults/main.yml").read_text())
    out = {}
    for group in ("routing_cases", "namespace_cases", "budget_cases", "demo_cases"):
        for c in cases.get(group) or []:
            out[c["id"]] = c
    for c in access.get("validate_router_access_cases") or []:
        out[c["id"]] = c
    return out



def build_scenarios(raw: Path, picks: dict, prompts: dict[str, dict]) -> dict:
    lines = router_lines(raw)
    scenarios = []
    for p in picks["scenarios"]:
        spans = load_trace(raw / "raw/traces" / f"{p['trace']}.json")
        d = decision_from_trace(spans)
        request = {"who": p.get("who") or f"the validation suite, with the {d['team']} key", "team": d["team"]}
        case = prompts.get(p.get("case", ""))
        if case and case.get("prompt"):
            request["text"] = " ".join(case["prompt"].split())
            request["case"] = p["case"]
        else:
            request["summary"] = p["summary"]
            if p.get("case"):
                request["case"] = p["case"]
        request["prompt_chars"] = (lines.get(p["trace"]) or {}).get("prompt_chars") or (
            len(request["text"]) if "text" in request else None
        )
        scenarios.append(
            {
                "id": p["id"],
                "label": p["label"],
                "request": request,
                **{k: d[k] for k in ("routed_to", "decided_by", "reason", "steps", "model", "duration_ms", "ts")},
                "trace_id": p["trace"],
            }
        )
    return {"gates": GATES, "destinations": DESTINATIONS, "scenarios": scenarios}


def tree_order(spans: list[dict], keep: list[dict]) -> list[tuple[dict, str]]:
    """The kept spans in tree order (each parent, then its children by start time), with their kept parent.

    A child with the same start and end as its parent must not come before it, so a flat sort by time
    is not enough. A span whose parent was dropped hangs from its nearest kept ancestor.
    """
    ids = {s["id"] for s in spans}
    kept_ids = {s["id"] for s in keep}
    parent_of = {s["id"]: s["parent"] for s in spans}

    def kept_parent(s: dict) -> str:
        parent = s["parent"]
        while parent and parent not in kept_ids and parent in ids:
            parent = parent_of[parent]
        return parent if parent in kept_ids else ""

    children: dict[str, list[dict]] = {}
    for s in keep:
        children.setdefault(kept_parent(s), []).append(s)
    ordered: list[tuple[dict, str]] = []
    stack = [("", sorted(children.get("", []), key=lambda s: (s["start"], -s["end"], s["name"])))]
    while stack:
        parent_id, todo = stack[-1]
        if not todo:
            stack.pop()
            continue
        s = todo.pop(0)
        ordered.append((s, parent_id))
        stack.append((s["id"], sorted(children.get(s["id"], []), key=lambda c: (c["start"], -c["end"], c["name"]))))
    return ordered


def build_traces(raw: Path, picks: dict) -> dict:
    traces = []
    for p in picks["waterfall"]:
        spans = load_trace(raw / "raw/traces" / f"{p['trace']}.json")
        keep = [s for s in spans if s["name"] in SPAN_ATTRS or s["name"].startswith("gate.")]
        kept_ids = {s["id"] for s in keep}
        t0 = min(s["start"] for s in keep)
        t1 = max(s["end"] for s in keep)
        short = {sid: f"s{i}" for i, sid in enumerate(sorted(kept_ids))}
        ordered = tree_order(spans, keep)
        out = []
        for s, parent in ordered:
            out.append(
                {
                    "id": short[s["id"]],
                    "parent": short.get(parent, ""),
                    "name": s["name"],
                    "service": s["service"],
                    "start_ms": round((s["start"] - t0) / 1e6, 2),
                    "dur_ms": round((s["end"] - s["start"]) / 1e6, 2),
                    "attrs": allowed_attrs(s["name"], s["attrs"]),
                }
            )
        traces.append(
            {
                "id": p["id"],
                "label": p["label"],
                "trace_id": p["trace"],
                "started": iso(t0),
                "duration_ms": round((t1 - t0) / 1e6, 1),
                "spans": out,
            }
        )
    return {"traces": traces}


TS = r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)"


def parse_ts(s: str) -> float:
    s = re.sub(r"(\.\d{6})\d*Z$", r"\1Z", s)
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC).timestamp()


def build_investigation(raw: Path, picks: dict) -> dict:
    inv = picks["investigation"]
    ns = inv["namespace"]
    start = parse_ts(inv["start"].replace("Z", ".000000Z"))
    end = parse_ts(inv["end"].replace("Z", ".000000Z"))
    events = []

    def add(ts: float, lane: str, kind: str, title: str, **extra):
        if start <= ts <= end:
            events.append({"t": ts, "lane": lane, "kind": kind, "title": title, **extra})

    for line in (raw / "raw" / inv["translator_log"]).read_text(errors="replace").splitlines():
        m = re.search(TS + r".*Accepted alert webhook .*alerts=(\d+).*namespace=([a-z0-9-]+)\s*$", line)
        if m and m.group(3) == ns:
            add(parse_ts(m.group(1)), "alert", "webhook", "Alertmanager webhook reaches the translator",
                detail=f"{m.group(2)} alert(s), namespace {ns}")
        m = re.search(TS + r".*Forwarded alert prompt to triage-agent http://triage-agent\.([a-z0-9-]+)\.svc:\d+/trigger -> (\d+)", line)
        if m and m.group(2) == ns:
            add(parse_ts(m.group(1)), "alert", "trigger", "The translator calls the agent of the namespace",
                detail=f"POST /trigger -> {m.group(3)}")

    calls = {}
    for line in (raw / "raw" / inv["agent_log"]).read_text(errors="replace").splitlines():
        m = re.match(TS + r" .*Tool call (started|completed): (.+?) → ([a-z_]+)", line)
        if m:
            t = parse_ts(m.group(1))
            key = (m.group(3), m.group(4))
            if m.group(2) == "started":
                calls.setdefault(key, []).append([t, None])
            else:
                for c in calls.get(key, []):
                    if c[1] is None:
                        c[1] = t
                        break
            continue
        m = re.match(TS + r" .*Triggered run starting", line)
        if m:
            add(parse_ts(m.group(1)), "agent", "run_start", "The agent starts the investigation")
        m = re.match(TS + r" .*Triggered run finished \((\d+) chars\)", line)
        if m:
            add(parse_ts(m.group(1)), "agent", "run_end", "The agent writes its report",
                detail=f"report of {m.group(2)} characters")
    for (server, tool), items in calls.items():
        for t0, t1 in items:
            add(t0, "tools", "tool", tool, detail=server.replace(" MCP", "") + " MCP",
                dur_s=round((t1 or t0) - t0, 3))

    turn = 0
    for tid in (raw / "raw" / inv["trace_ids"]).read_text().split():
        if not re.fullmatch(r"[0-9a-f]{32}", tid):
            continue
        spans = load_trace(raw / "raw/traces" / f"{tid}.json")
        d = decision_from_trace(spans)
        turn += 1
        add(parse_ts(d["ts"].replace("Z", "000Z")), "llm", "llm", f"LLM turn {turn}",
            dur_s=round(d["duration_ms"] / 1000, 2), routed_to=d["routed_to"], decided_by=d["decided_by"],
            reason=d["reason"], model=d["model"], tokens_in=d["tokens_in"], tokens_out=d["tokens_out"],
            trace_id=tid)

    incidents = json.loads((raw / "raw/incidents.json").read_text())["result"]
    inc = next(i for i in incidents if i["number"] == inv["incident"])
    opened = datetime.strptime(inc["opened_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC).timestamp()
    # opened_at has whole seconds: the incident exists when the create_incident call that made it ends.
    made = [t1 for (_, tool), items in calls.items() if tool == "create_incident" for _, t1 in items
            if t1 and abs(t1 - opened) < 2]
    # Only the number and the priority: the text of the incident was written by the agent's model.
    add(made[0] if made else opened, "ticket", "incident", f"Incident {inc['number']} opened",
        detail=f"priority {inc['priority']}")

    if not any(e["lane"] == "alert" for e in events):
        raise SystemExit(f"{inv['translator_log']}: no webhook or trigger of {ns}; capture it with oc logs --timestamps")
    order = {"webhook": 0, "trigger": 1, "run_start": 2}
    events.sort(key=lambda e: (round(e["t"], 1), order.get(e["kind"], 5), e["t"]))
    t0 = events[0]["t"]
    for e in events:
        e["offset_s"] = round(e["t"] - t0, 3)
        e["ts"] = datetime.fromtimestamp(e.pop("t"), UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "namespace": ns,
        "data_class": inv["data_class"],
        "alert": {
            "name": "QuarkusBuggyAppHighErrorRate",
            "rule": f"the share of HTTP 5xx answers of {BUGGY_APPS.get(ns, 'the buggy app')} is above 10% for 5 minutes",
        },
        "incident": {
            "number": inc["number"],
            "priority": inc["priority"],
            "opened_at": inc["opened_at"].replace(" ", "T") + "Z",
        },
        "events": events,
        "notes": [
            (
                "The alert was already firing when the cluster finished its install, so T0 is the webhook, "
                "not the alert."
            ),
            "Times come from the translator and agent logs, the router traces (Tempo) and the incident.",
            "Prompts, model answers and the text of the incident were removed; only its number and priority are kept.",
        ],
    }


def router_version(raw: Path, gitops: Path | None, picks: dict) -> str:
    """routerVersion of gitops at the revision the cluster ran (raw/meta.json of capture.py), else picks."""
    meta_file = raw / "raw/meta.json"
    if gitops and meta_file.exists():
        rev = json.loads(meta_file.read_text()).get("gitops_revision")
        if rev:
            values = subprocess.run(["git", "-C", str(gitops), "show", f"{rev}:components/litellm-router/values.yaml"],
                                    check=True, capture_output=True, text=True).stdout
            return yaml.safe_load(values)["routerVersion"]
    return picks["router_version"]


def write_js(path: Path, name: str, meta: dict, value: dict) -> None:
    body = {"schema": 1, **meta, **value}
    text = json.dumps(body, indent=1, ensure_ascii=False)
    found = leaks(text)
    if found:
        raise SystemExit(f"{path.name}: possible leak {found[0]!r}; fix the allowlist first")
    path.write_text(
        "// Generated by tools/sanitize.py. Do not edit by hand.\n"
        f"window.DEMO = window.DEMO || {{}};\nwindow.DEMO.{name} = {text};\n"
    )
    print(f"wrote {path.relative_to(ROOT)} ({len(text)} bytes)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--raw", type=Path, required=True, help="capture directory (with raw/)")
    ap.add_argument("--validation", type=Path, required=True, help="checkout of the validation repo")
    ap.add_argument("--gitops", type=Path, help="checkout of the gitops repo: router version of the capture")
    ap.add_argument("--picks", type=Path, default=ROOT / "tools/picks.json")
    ap.add_argument("--out", type=Path, default=ROOT / "data")
    args = ap.parse_args()
    picks = json.loads(args.picks.read_text())
    meta = {"captured_at": picks["captured_at"], "router_version": router_version(args.raw, args.gitops, picks),
            "cluster": "redacted"}
    prompts = validation_prompts(args.validation)
    write_js(args.out / "scenarios.js", "scenarios", meta, build_scenarios(args.raw, picks, prompts))
    write_js(args.out / "traces.js", "traces", meta, build_traces(args.raw, picks))
    write_js(args.out / "investigation.js", "investigation", meta, build_investigation(args.raw, picks))


if __name__ == "__main__":
    main()
