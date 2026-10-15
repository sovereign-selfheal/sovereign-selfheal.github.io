# sovereign-selfheal.github.io

The site of the demo **Sovereign Self-Healing: LLM Routing and AI SRE Triage on OpenShift AI**:
<https://sovereign-selfheal.github.io/>.

It explains the demo to people who do not know it yet, with four interactive parts, and shows how to
install it:

| Part | What it shows | Data |
|------|---------------|------|
| Routing simulator | Real requests go through the four gates of the router, to the local model or the SOTA model | `data/scenarios.js` |
| Investigation replay | A real investigation, from the Alertmanager webhook to the incident | `data/investigation.js` |
| Trace waterfall | Real router traces from Tempo, with the gates as child spans | `data/traces.js` |
| Architecture map | Every component, what it does and its repository | `data/components.js` (written by hand) |
| Install guide | `install.html`: a short guide; the ansible README stays the reference | |

## How it is built

- Static files only: HTML, CSS and plain JavaScript. No build step, no framework.
- GitHub Pages serves the branch `main` from the root (`.nojekyll` turns Jekyll off).
- The page loads nothing from other sites: no CDN, no analytics, and the Red Hat fonts are served from
  `fonts/` (SIL Open Font License 1.1). A Content Security
  Policy in every page enforces it.
- The data files set `window.DEMO.<name>`, so the page also works when opened from disk (`file://`).
- Animations stop when a widget is off screen, and `prefers-reduced-motion` shows the final state.
- Two themes, dark and light: the page follows the system setting (`prefers-color-scheme`), and the
  button in the menu switches it (the choice is kept in the browser, `localStorage`). All colors are
  CSS variables in `css/site.css`; the scripts use classes, never color values.

## Preview

```bash
python3 -m http.server -d . 8000    # then open http://localhost:8000/
```

## Refresh the data

The data comes from a live demo cluster. The raw capture holds prompts, answers and host names, so
it never goes into this repository.

```bash
# 1. capture (read-only), into a directory OUTSIDE this repository
uv run --project tools python tools/capture.py --out ../site-capture \
  --trace <trace id> --search agents-payments 2026-10-15T05:39:40Z 2026-10-15T05:41:00Z \
  --prom-start 2026-10-15T05:10:00Z --prom-end 2026-10-15T07:50:00Z

# the translator scales to zero: follow its logs during the alert path, with timestamps
oc logs -f -n agentic-triage deploy/ogx-alert-translator --timestamps > ../site-capture/raw/translator.log

# 2. pick the requests and the investigation: edit tools/picks.json

# 3. build data/*.js; only an allowlist of fields is copied
uv run --project tools python tools/sanitize.py --raw ../site-capture --validation ../validation --gitops ../gitops

# 4. check before the commit (also run by the CI)
uv run --project tools python tools/check_site.py --strip-png
```

`check_site.py` fails on resources from other sites or missing local files, a weaker Content Security
Policy, broken links and anchors, data without the `cluster: "redacted"` marker, text of the agents or
of incidents in the data (only the prompts of validation cases are allowed), cluster host names,
tokens, private addresses and e-mail addresses, and PNG files with metadata chunks (`--strip-png`
removes them).

## Screenshots

Images in `img/` must not show host names, user names or tokens. Crop the browser bar before you add
a screenshot, and run `check_site.py --strip-png`.

## License

Apache License 2.0, see [LICENSE](LICENSE). Trademarks: see [NOTICE](NOTICE).
