"""Check the site before a commit: no third-party resources, working links, clean data and images.

    uv run --project tools python tools/check_site.py [--strip-png]

Exit code 1 when a check fails. The CI (.github/workflows/check.yml) runs it on every push.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {".html", ".js", ".css", ".md", ".json", ".toml", ".yml", ".yaml", ".svg", ".py", ".txt"}
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__"}
# Host names, tokens, addresses and e-mail addresses of a real cluster must never reach the site.
LEAK = re.compile(
    r"opentlc\.com|sandbox\d{3,}|\bocp\.[a-z0-9]{5}\.|hxppg|sha256~[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9._-]{12,}|"
    r"\bsk-[A-Za-z0-9]{12,}|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|"
    r"\b192\.168\.\d{1,3}\.\d{1,3}\b|[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[a-z]{2,}"
)
LEAK_ALLOW = {"noreply@anthropic.com"}
PNG_TEXT = {b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"tIME"}
DATA_KEYS = {"schema", "captured_at", "router_version", "cluster"}

problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


class Page(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.refs: list[tuple[str, str, str]] = []  # (tag, attr, value)
        self.csp = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "meta" and a.get("http-equiv", "").lower() == "content-security-policy":
            self.csp = "default-src 'self'" in a.get("content", "") and "script-src 'self'" in a.get("content", "")
        for attr in ("src", "href"):
            if attr in a and a[attr] is not None:
                self.refs.append((tag, attr, a[attr]))


def pages() -> dict[Path, Page]:
    out = {}
    for f in sorted(ROOT.glob("*.html")):
        p = Page()
        p.feed(f.read_text())
        out[f] = p
    return out


def check_pages() -> None:
    parsed = pages()
    for f, p in parsed.items():
        if not p.csp:
            fail(f"{f.name}: no Content-Security-Policy with default-src 'self' and script-src 'self'")
        for tag, attr, val in p.refs:
            external = re.match(r"^[a-z]+:|^//", val)
            if tag != "a":
                # Anything the browser loads (script, img, stylesheet, icon) must come from this site.
                if external and not val.startswith("data:"):
                    fail(f"{f.name}: <{tag} {attr}={val!r}> loads from another site")
                continue
            if external:
                if not val.startswith(("https://", "mailto:")):
                    fail(f"{f.name}: link {val!r} is not https")
                continue
            target, _, anchor = val.partition("#")
            target_file = f if not target else (ROOT / target.lstrip("/")).resolve()
            if target and not target_file.exists():
                fail(f"{f.name}: link {val!r}: {target} does not exist")
                continue
            if anchor and target_file.suffix == ".html":
                ids = parsed.get(target_file, Page()).ids
                if anchor not in ids and anchor != "top":
                    fail(f"{f.name}: link {val!r}: no id {anchor!r} in {target_file.name}")
        # Scripts must exist.
        for tag, attr, val in p.refs:
            if tag == "script" and not (ROOT / val).exists():
                fail(f"{f.name}: script {val} does not exist")


def load_data(f: Path):
    text = f.read_text()
    m = re.search(r"window\.DEMO\.(\w+) = ", text)
    if not m:
        fail(f"{f.name}: no window.DEMO.<name> = ...")
        return None, None
    body = text[m.end():].rstrip().rstrip(";")
    if f.name == "components.js":
        return m.group(1), None  # hand-written JS object, not JSON
    try:
        return m.group(1), json.loads(body)
    except json.JSONDecodeError as e:
        fail(f"{f.name}: not valid JSON after the assignment: {e}")
        return m.group(1), None


def check_data() -> None:
    for f in sorted((ROOT / "data").glob("*.js")):
        name, d = load_data(f)
        if d is None:
            continue
        missing = DATA_KEYS - d.keys()
        if missing:
            fail(f"{f.name}: missing keys {sorted(missing)}")
        if d.get("cluster") != "redacted":
            fail(f"{f.name}: cluster must be 'redacted'")
        if name == "scenarios":
            gates = {g["id"] for g in d["gates"]}
            for s in d["scenarios"]:
                for st in s["steps"]:
                    if st["gate"] not in gates:
                        fail(f"{f.name}: scenario {s['id']}: unknown gate {st['gate']}")
                    if not st["reason"].startswith(st["gate"] + ":"):
                        fail(f"{f.name}: scenario {s['id']}: reason {st['reason'][:40]!r} does not start with {st['gate']}:")
                if s["routed_to"] not in d["destinations"]:
                    fail(f"{f.name}: scenario {s['id']}: unknown destination {s['routed_to']}")
        if name == "investigation":
            offsets = [e["offset_s"] for e in d["events"]]
            if offsets != sorted(offsets, key=lambda o: round(o, 1)):
                fail(f"{f.name}: events are not in time order")
            for e in d["events"]:
                if "prompt" in e or "text" in e:
                    fail(f"{f.name}: event {e['title']!r} carries prompt text")


def check_leaks() -> None:
    for f in sorted(ROOT.rglob("*")):
        if not f.is_file() or SKIP_DIRS & set(f.relative_to(ROOT).parts) or f.suffix not in TEXT_SUFFIXES:
            continue
        if f.name == "check_site.py" or f.name == "sanitize.py":
            continue  # they hold the patterns themselves
        for n, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            for m in LEAK.finditer(line):
                if m.group(0) not in LEAK_ALLOW:
                    fail(f"{f.relative_to(ROOT)}:{n}: possible leak {m.group(0)!r}")


def png_chunks(data: bytes):
    i = 8
    while i < len(data):
        (n,) = struct.unpack(">I", data[i:i + 4])
        yield data[i + 4:i + 8], data[i:i + 12 + n]
        i += 12 + n


def check_png(strip: bool) -> None:
    for f in sorted(ROOT.rglob("*.png")):
        if SKIP_DIRS & set(f.relative_to(ROOT).parts):
            continue
        data = f.read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            fail(f"{f.relative_to(ROOT)}: not a PNG file")
            continue
        found = [t.decode() for t, _ in png_chunks(data) if t in PNG_TEXT]
        if not found:
            continue
        if strip:
            f.write_bytes(data[:8] + b"".join(c for t, c in png_chunks(data) if t not in PNG_TEXT))
            print(f"stripped {sorted(set(found))} from {f.relative_to(ROOT)}")
        else:
            fail(f"{f.relative_to(ROOT)}: metadata chunks {sorted(set(found))} (run with --strip-png)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--strip-png", action="store_true", help="remove text and time chunks from the PNG files")
    args = ap.parse_args()
    check_pages()
    check_data()
    check_leaks()
    check_png(args.strip_png)
    for p in problems:
        print("FAIL", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
