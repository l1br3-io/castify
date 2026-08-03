#!/usr/bin/env python3
"""Validate plan.md thinness — per-task detail belongs in tasks/, not the plan.

The plan is a thin index: Overview, Architecture Decisions, a Task Index of
phase-grouped pointer lines + checkpoints, Risks, Open Questions. Per-task
detail (acceptance criteria, file lists, verification steps) lives in the
linked `tasks/00N-<slug>.md` files. A thick plan bloats every /build step
that has to read it (see planning-and-task-breakdown/SKILL.md § Effort File
Lifecycle and the "plan.md growing thick" red flag).

Three checks, each tuned for near-zero false positives:

  1. Per-task detail headers — the bold sub-headers from the task-file
     template (**Acceptance criteria:**, **Verification:**, **Files likely
     touched:**, **Dependencies:**, **Description:**, **Docs:**, **Estimated
     scope:**) never belong in plan.md. Their presence means a task's body was
     pasted into the index.
  2. Task pointer integrity — every "Task N:" checkbox line must link to its
     detail file (tasks/00N-<slug>.md). A task with no pointer is either
     missing its detail file or has inlined the detail into the plan.
  3. Inlined sub-content — a task pointer line should stand alone. Indented
     lines immediately following it (before the next non-indented line) are
     acceptance/file-list detail that belongs in the task file.

Scans docs/specs/**/plan.md. Exits 0 (with a note) when none exist, so
projects that don't use the spec flow are unaffected — the validator only
fires where plans actually live.

Usage:
    python3 .opencode/harness/scripts/lint-plan.py [repo_root]
Exit 1 if any plan.md is thick, 0 otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Per-task detail headers from the task-file template
# (planning-and-task-breakdown/SKILL.md § Step 4). These never belong in
# plan.md — their presence means a task's body was pasted into the index.
TASK_DETAIL_HEADERS = (
    "**Description:**",
    "**Acceptance criteria:**",
    "**Verification:**",
    "**Dependencies:**",
    "**Files likely touched:**",
    "**Docs:**",
    "**Estimated scope:**",
)

# A task line in the Task Index. Canonical form:
#   - [ ] Task 1: [title] → `tasks/001-slug.md`
# Accepts `-`/`*` markers, `[ ]`/`[x]`/`[X]` boxes, case-insensitive "Task".
TASK_LINE_RE = re.compile(r"^[-*]\s+\[[ xX]\]\s+Task\s+\d+", re.IGNORECASE)

# A pointer to a task detail file: tasks/00N-...md. The char class after the
# digits accepts real slugs (db-setup) AND template placeholders (<slug>).
TASK_POINTER_RE = re.compile(r"tasks/\d+[\w.<>/-]*\.md")

# Indented sub-content: 2+ spaces or a tab before a non-whitespace char.
INDENT_RE = re.compile(r"^[ \t]{2,}\S")


def check_plan(rel: str, text: str) -> list[str]:
    """Return a list of thickness errors for one plan.md file."""
    errors: list[str] = []
    lines = text.splitlines()

    # Rule 1 — per-task detail headers anywhere in the file.
    for i, line in enumerate(lines, 1):
        for header in TASK_DETAIL_HEADERS:
            if header in line:
                errors.append(
                    f"{rel}:{i}: per-task detail header {header!r} belongs in "
                    f"tasks/00N-*.md, not plan.md"
                )

    # Rules 2 & 3 — walked together, line by line.
    for i, line in enumerate(lines, 1):
        if not TASK_LINE_RE.match(line):
            continue

        # Rule 2 — task line must carry a pointer to its detail file.
        if not TASK_POINTER_RE.search(line):
            errors.append(
                f"{rel}:{i}: task line missing pointer to "
                f"tasks/00N-<slug>.md — add '→ `tasks/NNN-slug.md`' or split "
                f"the detail into a task file"
            )
            # Skip the look-ahead: with no pointer the line is already flagged,
            # and trailing indented lines are part of the same defect.
            continue

        # Rule 3 — no indented sub-content directly after a task pointer line.
        # `lines[i]` is the line after the current one (i is 1-indexed).
        for j in range(i, len(lines)):
            nxt = lines[j]
            if not nxt.strip():
                continue  # blank lines don't end the task's scope
            if INDENT_RE.match(nxt):
                errors.append(
                    f"{rel}:{j + 1}: inlined per-task detail under task line "
                    f"{i} — move acceptance/file-list content to "
                    f"tasks/00N-*.md"
                )
            break  # first non-blank line ends the scope either way

    return errors


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()

    specs_dir = root / "docs" / "specs"
    if not specs_dir.is_dir():
        print("OK — no docs/specs/ found (spec flow not in use).")
        return 0

    plans = sorted(specs_dir.rglob("plan.md"))
    if not plans:
        print("OK — no plan.md files under docs/specs/ (spec flow not in use).")
        return 0

    all_errors: list[str] = []
    for p in plans:
        rel = p.relative_to(root)
        text = p.read_text(encoding="utf-8", errors="replace")
        all_errors += check_plan(str(rel), text)

    if all_errors:
        print(f"Thick plan.md ({len(all_errors)} issue(s)):")
        for e in all_errors:
            print(f"  {e}")
        print(
            "\nplan.md is a thin index. Per-task detail (acceptance criteria, "
            "file lists, verification steps) belongs in tasks/00N-<slug>.md — "
            "replace inlined content with a one-line pointer: "
            "'- [ ] Task N: title → `tasks/00N-slug.md`'."
        )
        return 1

    print(f"OK — {len(plans)} plan.md file(s) thin (per-task detail in tasks/).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
