"""Capture the raw data of the widgets from a live demo cluster (read-only).

    uv run --project tools python tools/capture.py --out <dir> \
        --trace <trace id> ... --search agents-payments 2026-10-15T05:39:40Z 2026-10-15T05:41:00Z

Needs `oc`, logged in as a user who can read the router, agent and observability namespaces.
The result holds prompts, answers and host names: keep it OUT of this repository, then run
sanitize.py on it. The translator scales to zero, so its logs disappear a few minutes after an
alert: follow them while the alert path runs (`oc logs -f`) and save them as raw/translator.log.
"""

from __future__ import annotations

import argparse
import json
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROUTER_NS = "maas-routing"
TICKETING_NS = "agentic-triage"
TEMPO = ("observability", "svc/tempo-tempo-gateway", 8080, "router")
QUERIES = {
    "alerts": 'ALERTS{alertname="QuarkusBuggyAppHighErrorRate"}',
    "translator-replicas": 'kube_deployment_status_replicas{deployment="ogx-alert-translator"}',
}


def oc(*args: str) -> str:
    return subprocess.run(["oc", *args], check=True, capture_output=True, text=True).stdout


def save(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(f"saved {path} ({len(text)} bytes)")


def get(url: str, token: str, params: dict | None = None) -> bytes:
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # port-forward and the in-cluster CA: no public certificate
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        return r.read()


def capture_logs(raw: Path) -> None:
    for pod in oc("get", "pods", "-n", ROUTER_NS, "-l", "app=litellm", "-o", "name").split():
        save(raw / f"litellm-{pod.split('/')[1]}.log", oc("logs", "-n", ROUTER_NS, pod, "-c", "litellm", "--timestamps"))
    agents = json.loads(oc("get", "triageagents", "-A", "-o", "json"))["items"]
    for a in agents:
        ns, name = a["metadata"]["namespace"], a["metadata"]["name"]
        for c in ("triage-agent", "ogx-server"):
            save(raw / f"triage-agent-{ns}-{c}.log", oc("logs", "-n", ns, f"deploy/{name}", "-c", c, "--timestamps"))
    code = 'import urllib.request; print(urllib.request.urlopen("http://localhost:8080/api/incidents").read().decode())'
    save(raw / "incidents.json", oc("exec", "-n", TICKETING_NS, "deploy/ticketing-system", "--", "python3", "-c", code))


def capture_prometheus(raw: Path, token: str, start: str, end: str) -> None:
    host = oc("get", "route", "thanos-querier", "-n", "openshift-monitoring", "-o", "jsonpath={.spec.host}")
    for name, q in QUERIES.items():
        body = get(f"https://{host}/api/v1/query_range", token, {"query": q, "start": start, "end": end, "step": "15s"})
        save(raw / f"prom-{name}.json", body.decode())


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def capture_traces(raw: Path, token: str, trace_ids: list[str], searches: list[list[str]]) -> None:
    ns, svc, port, tenant = TEMPO
    local = free_port()
    pf = subprocess.Popen(["oc", "port-forward", "-n", ns, svc, f"{local}:{port}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"https://127.0.0.1:{local}/api/traces/v1/{tenant}/tempo/api"
    try:
        for _ in range(30):
            try:
                get(base + "/search", token, {"limit": 1})
                break
            except OSError:
                time.sleep(1)
        for team, start, end in searches:
            to_unix = lambda s: str(int(datetime.fromisoformat(s).timestamp()))
            body = json.loads(get(base + "/search", token, {
                "q": f'{{ span.route.team = "{team}" }}', "start": to_unix(start), "end": to_unix(end), "limit": 50}))
            found = sorted(body.get("traces", []), key=lambda t: int(t["startTimeUnixNano"]))
            save(raw / "traces" / f"search-{team}-{start[11:16].replace(':', '')}.txt", "\n".join(t["traceID"] for t in found) + "\n")
            trace_ids += [t["traceID"] for t in found]
        for tid in dict.fromkeys(trace_ids):
            save(raw / "traces" / f"{tid}.json", get(f"{base}/traces/{tid}", token).decode())
    finally:
        pf.terminate()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True, help="capture directory, outside the repository")
    ap.add_argument("--trace", action="append", default=[], help="a trace id to download (repeat)")
    ap.add_argument("--search", nargs=3, action="append", default=[], metavar=("TEAM", "START", "END"),
                    help="download the router traces of a team in a time window (ISO 8601 UTC)")
    ap.add_argument("--prom-start", help="start of the Prometheus range (ISO 8601 UTC)")
    ap.add_argument("--prom-end", help="end of the Prometheus range (ISO 8601 UTC)")
    args = ap.parse_args()
    if (Path(__file__).resolve().parent.parent in args.out.resolve().parents):
        sys.exit("--out must be outside the repository: the raw capture is not public")
    raw = args.out / "raw"
    token = oc("whoami", "-t").strip()
    capture_logs(raw)
    if args.prom_start and args.prom_end:
        capture_prometheus(raw, token, args.prom_start, args.prom_end)
    if args.trace or args.search:
        capture_traces(raw, token, list(args.trace), args.search)


if __name__ == "__main__":
    main()
