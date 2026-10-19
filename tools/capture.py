"""Capture the raw data of the widgets from a live demo cluster (read-only).

    uv run --project tools python tools/capture.py --out <dir> \
        --trace <trace id> ... --search agents-payments 2026-10-15T05:39:40Z 2026-10-15T05:41:00Z

Needs `oc`, logged in as a user who can read the router, agent and observability namespaces.
The result holds prompts, answers and host names: keep it OUT of this repository, then run
sanitize.py on it. The translator scales to zero, so its logs disappear a few minutes after an
alert: follow them while the alert path runs (`oc logs -f --timestamps`, the timestamps are needed by
sanitize.py) and save them as raw/translator.log.

Requests to cluster routes check the TLS certificate (the token is cluster-admin); use
--insecure-routes only on a cluster with the self-signed router certificate. The Tempo port-forward
on 127.0.0.1 never checks it (in-cluster CA).
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
    "alerts": 'ALERTS{alertname="AppHighErrorRate"}',
    "translator-replicas": 'kube_deployment_status_replicas{deployment="ogx-alert-translator"}',
}


def oc(*args: str) -> str:
    return subprocess.run(["oc", *args], check=True, capture_output=True, text=True).stdout


def save(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print(f"saved {path} ({len(text)} bytes)")


def get(url: str, token: str, params: dict | None = None, verify: bool = True) -> bytes:
    """GET with the bearer token. verify=False only for 127.0.0.1 (port-forward, in-cluster CA)."""
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
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
    # sanitize.py reads the router version from the gitops repo at this revision.
    app = json.loads(oc("get", "application", "litellm-router", "-n", "openshift-gitops", "-o", "json"))
    image = oc("get", "deploy", "litellm", "-n", ROUTER_NS, "-o",
               "jsonpath={.spec.template.spec.containers[?(@.name==\"litellm\")].image}")
    meta = {"captured_at": datetime.now().date().isoformat(),
            "gitops_revision": app["status"]["sync"]["revision"], "router_image": image}
    save(raw / "meta.json", json.dumps(meta) + "\n")


def capture_prometheus(raw: Path, token: str, start: str, end: str, verify: bool) -> None:
    host = oc("get", "route", "thanos-querier", "-n", "openshift-monitoring", "-o", "jsonpath={.spec.host}")
    for name, q in QUERIES.items():
        params = {"query": q, "start": start, "end": end, "step": "15s"}
        body = get(f"https://{host}/api/v1/query_range", token, params, verify=verify)
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
                get(base + "/search", token, {"limit": 1}, verify=False)
                break
            except OSError:
                time.sleep(1)
        for team, start, end in searches:
            to_unix = lambda s: str(int(datetime.fromisoformat(s).timestamp()))
            body = json.loads(get(base + "/search", token, {
                "q": f'{{ span.route.team = "{team}" }}', "start": to_unix(start), "end": to_unix(end), "limit": 50},
                verify=False))
            found = sorted(body.get("traces", []), key=lambda t: int(t["startTimeUnixNano"]))
            save(raw / "traces" / f"search-{team}-{start[11:16].replace(':', '')}.txt", "\n".join(t["traceID"] for t in found) + "\n")
            trace_ids += [t["traceID"] for t in found]
        for tid in dict.fromkeys(trace_ids):
            save(raw / "traces" / f"{tid}.json", get(f"{base}/traces/{tid}", token, verify=False).decode())
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
    ap.add_argument("--insecure-routes", action="store_true",
                    help="do not check the TLS certificate of cluster routes (self-signed router certificate)")
    args = ap.parse_args()
    repo, out = Path(__file__).resolve().parent.parent, args.out.resolve()
    if out == repo or repo in out.parents:
        sys.exit("--out must be outside the repository: the raw capture is not public")
    raw = args.out / "raw"
    token = oc("whoami", "-t").strip()
    capture_logs(raw)
    if args.prom_start and args.prom_end:
        capture_prometheus(raw, token, args.prom_start, args.prom_end, verify=not args.insecure_routes)
    if args.trace or args.search:
        capture_traces(raw, token, list(args.trace), args.search)


if __name__ == "__main__":
    main()
