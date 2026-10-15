"""Text that must never reach the site: host names of a demo cluster, tokens, keys, private addresses
and e-mail addresses. One pattern, shared by sanitize.py (before it writes) and check_site.py (CI).
"""

import re

LEAK = re.compile(
    r"opentlc\.com|sandbox\d{3,}|\bocp\.[a-z0-9]{5}\.|sha256~[A-Za-z0-9_-]{8,}|Bearer [A-Za-z0-9._-]{12,}|"
    r"\bsk-[A-Za-z0-9]{12,}|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|"
    r"\b192\.168\.\d{1,3}\.\d{1,3}\b|[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[a-z]{2,}"
)

# Matches of LEAK that are fine on a public page.
ALLOW = {"noreply@anthropic.com"}


def leaks(text: str) -> list[str]:
    """The matches of LEAK in text, without the allowed ones."""
    return [m.group(0) for m in LEAK.finditer(text) if m.group(0) not in ALLOW]
