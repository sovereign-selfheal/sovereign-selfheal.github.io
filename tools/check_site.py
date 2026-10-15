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

from leaks import leaks

ROOT = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {".html", ".js", ".css", ".md", ".json", ".toml", ".yml", ".yaml", ".svg", ".py", ".txt"}
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__"}
# The CSP every page must have: nothing from other sites, no inline or foreign scripts.
CSP_REQUIRED = {"default-src": ["'self'"], "script-src": ["'self'"], "connect-src": ["'none'"],
                "object-src": ["'none'"], "base-uri": ["'none'"]}
# Text written by a model or by a person (agent prompts, answers, incident text) never reaches the site.
# Only the prompts of validation cases (synthetic, public in the validation repo) may be shown.
FORBIDDEN_DATA_KEYS = {"prompt", "answer", "description", "short_description", "content", "messages"}
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
        self.csp: dict[str, list[str]] | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        if tag == "meta" and a.get("http-equiv", "").lower() == "content-security-policy":
            self.csp = {}
            for directive in (a.get("content") or "").split(";"):
                words = directive.split()
                if words:
                    self.csp[words[0]] = words[1:]
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
        if p.csp is None:
            fail(f"{f.name}: no Content-Security-Policy")
        else:
            for name, values in CSP_REQUIRED.items():
                if p.csp.get(name) != values:
                    fail(f"{f.name}: CSP {name} is {p.csp.get(name)}, expected {values}")
        for tag, attr, val in p.refs:
            external = re.match(r"^[a-z]+:|^//", val)
            if tag != "a":
                # Anything the browser loads (script, img, stylesheet, icon) must come from this site,
                # and must exist.
                if external and not val.startswith("data:"):
                    fail(f"{f.name}: <{tag} {attr}={val!r}> loads from another site")
                elif val.startswith("#"):
                    if val[1:] not in p.ids:
                        fail(f"{f.name}: <{tag} {attr}={val!r}>: no id {val[1:]!r} in the page")
                elif not external:
                    path = (ROOT / val.split("#")[0].split("?")[0].lstrip("/")).resolve()
                    if not path.is_file():
                        fail(f"{f.name}: <{tag} {attr}={val!r}>: the file does not exist")
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


def forbidden_keys(value, where: str) -> list[str]:
    """Paths of keys that would carry model or person text, anywhere in a data structure."""
    found = []
    if isinstance(value, dict):
        for k, v in value.items():
            if k in FORBIDDEN_DATA_KEYS:
                found.append(f"{where}.{k}")
            found += forbidden_keys(v, f"{where}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found += forbidden_keys(v, f"{where}[{i}]")
    return found


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
        for key in forbidden_keys(d, name):
            fail(f"{f.name}: {key}: model or person text is not allowed on the site")
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
                if "text" in s["request"] and not s["request"].get("case"):
                    fail(f"{f.name}: scenario {s['id']}: request text without a validation case")
        if name == "investigation":
            offsets = [e["offset_s"] for e in d["events"]]
            if offsets != sorted(offsets, key=lambda o: round(o, 1)):
                fail(f"{f.name}: events are not in time order")
            for e in d["events"]:
                if "text" in e:
                    fail(f"{f.name}: event {e['title']!r} carries text of the agent")


def check_leaks() -> None:
    for f in sorted(ROOT.rglob("*")):
        if not f.is_file() or SKIP_DIRS & set(f.relative_to(ROOT).parts) or f.suffix not in TEXT_SUFFIXES:
            continue
        if f.name == "leaks.py":
            continue  # it holds the patterns themselves
        for n, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            for match in leaks(line):
                fail(f"{f.relative_to(ROOT)}:{n}: possible leak {match!r}")


def check_theme() -> None:
    """Colors live in css/site.css (two themes): no color literals in the scripts."""
    for f in sorted((ROOT / "js").glob("*.js")):
        for n, line in enumerate(f.read_text().splitlines(), 1):
            if re.search(r"#[0-9a-fA-F]{6}\b|rgba?\(", line):
                fail(f"{f.relative_to(ROOT)}:{n}: color literal; use a CSS class or variable (themes)")


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
    check_theme()
    check_png(args.strip_png)
    for p in problems:
        print("FAIL", p)
    print(f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
