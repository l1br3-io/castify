#!/usr/bin/env python3
"""Check internal markdown references in the harness.

Validates references that point into the harness's own directories:
  - markdown links like `[text](rules/foo.md)`
  - backtick-wrapped paths like `` `rules/foo.md` `` or `` `../common/bar.md` ``

Skips fenced code blocks (so code samples don't produce false positives) and
external/placeholder targets. Designed to catch hard breaks such as a command
pointing at `references/foo.md` when the file actually lives at `rules/foo.md`.

Usage:
    python3 scripts/check-refs.py [repo_root]
Exit 1 if any internal reference is broken, 0 otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOTS = (
    ".opencode/harness/tech/",
    ".opencode/harness/rules/",
    ".opencode/skills/",
    ".opencode/agents/",
    ".opencode/commands/",
    ".opencode/harness/references/",
    ".opencode/harness/scripts/",
    "tests/",
)

# ](path) or ](path "title")
LINK_RE = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
BACKTICK_RE = re.compile(r"`([A-Za-z0-9_./-]+\.(?:md|sh|jsonc?|py))`")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


def strip_fences(text: str) -> str:
    """Drop fenced code block contents so code isn't scanned as prose."""
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return "\n".join(out)


def is_internal(ref: str) -> bool:
    return ref.startswith(REPO_ROOTS) or ref.startswith(("../", "./"))


def collect_refs(text: str) -> list[str]:
    refs = [m.group(1).split("#")[0] for m in LINK_RE.finditer(text)]
    refs += [m.group(1) for m in BACKTICK_RE.finditer(text)]
    return [r for r in refs if is_internal(r)]


def resolves(ref: str, src: Path, root: Path) -> bool:
    candidates = [(src.parent / ref).resolve()]
    if not ref.startswith("../"):
        candidates.append((root / ref).resolve())
    return any(c.exists() for c in candidates)


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()
    skip = {"node_modules", ".git", ".ruff_cache"}
    md_files = [
        p for p in sorted(root.rglob("*.md")) if not any(s in p.parts for s in skip)
    ]

    broken: list[tuple[Path, str]] = []
    for f in md_files:
        rel = f.relative_to(root)
        text = strip_fences(f.read_text(encoding="utf-8", errors="replace"))
        for ref in collect_refs(text):
            if not resolves(ref, f, root):
                broken.append((rel, ref))

    if broken:
        print(f"Broken references ({len(broken)}):")
        for src, ref in broken:
            print(f"  {src}: {ref}")
        return 1

    print(
        f"OK — all internal references resolve across {len(md_files)} markdown files."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
