#!/usr/bin/env python3
"""Validate frontmatter and tech-dir consistency.

Checks:
  1. Skills:      name (matches dir, valid pattern, <=64 chars), description (1-1024 chars)
  2. Agents:      description present
  3. Commands:    description present
  4. Tech files:  paths frontmatter present (except common/)
  5. Consistency: every tech/<dir>/ is mentioned in detect-tech.md and vice versa

Exit 1 if any check fails.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SKIP_DIRS = {".git", "__pycache__", ".ruff_cache", "node_modules"}


# ── frontmatter parser (minimal, handles plain + folded + list) ──────────────


def parse_frontmatter(text: str) -> dict:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fm: dict = {}
    current_key = None
    current_val: list[str] = []
    in_list = False

    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        if not stripped:
            continue

        # List item under a block key
        if in_list and stripped.startswith("- "):
            item = stripped[2:].strip().strip('"').strip("'")
            fm.setdefault(current_key, []).append(item)
            continue

        # Key-value pair
        m = re.match(r"^(\w[\w-]*)\s*:\s*(.*)$", line)
        if m:
            # Flush previous multi-line value
            if current_key and current_val and isinstance(fm.get(current_key), str):
                fm[current_key] += " " + " ".join(current_val)

            key, val = m.group(1), m.group(2).strip()
            if not val or val == ">":
                current_key = key
                current_val = []
                in_list = not bool(val and val != ">")
            else:
                fm[key] = val.strip('"').strip("'")
                current_key = key
                current_val = []
                in_list = False
        elif current_key:
            # Continuation line (plain multi-line scalar)
            current_val.append(stripped)

    # Flush trailing multi-line
    if current_key and current_val and isinstance(fm.get(current_key), str):
        fm[current_key] += " " + " ".join(current_val)

    return fm


def fm_length(fm: dict, key: str) -> int:
    val = fm.get(key, "")
    if isinstance(val, list):
        return len(" ".join(val))
    return len(str(val))


# ── checks ───────────────────────────────────────────────────────────────────


def check_skills(root: Path) -> list[str]:
    errors: list[str] = []
    skills_dir = root / ".opencode/skills"
    if not skills_dir.is_dir():
        return errors

    for skill_dir in sorted(skills_dir.iterdir()):
        if not skill_dir.is_dir():
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            errors.append(f"skills/{skill_dir.name}/: missing SKILL.md")
            continue

        fm = parse_frontmatter(skill_md.read_text())
        name = fm.get("name", "")

        if not name:
            errors.append(f"skills/{skill_dir.name}/SKILL.md: missing 'name'")
        else:
            if name != skill_dir.name:
                errors.append(
                    f"skills/{skill_dir.name}/SKILL.md: name '{name}' != dir '{skill_dir.name}'"
                )
            if not NAME_RE.match(name):
                errors.append(
                    f"skills/{skill_dir.name}/SKILL.md: name '{name}' fails pattern"
                )
            if len(name) > 64:
                errors.append(
                    f"skills/{skill_dir.name}/SKILL.md: name exceeds 64 chars"
                )

        if not fm.get("description"):
            errors.append(f"skills/{skill_dir.name}/SKILL.md: missing 'description'")
        elif fm_length(fm, "description") > 1024:
            errors.append(
                f"skills/{skill_dir.name}/SKILL.md: description exceeds 1024 chars"
            )

    return errors


def check_agents(root: Path) -> list[str]:
    errors: list[str] = []
    agents_dir = root / ".opencode/agents"
    if not agents_dir.is_dir():
        return errors

    for f in sorted(agents_dir.glob("*.md")):
        fm = parse_frontmatter(f.read_text())
        if not fm.get("description"):
            errors.append(f"agents/{f.name}: missing 'description'")

    return errors


def check_commands(root: Path) -> list[str]:
    errors: list[str] = []
    commands_dir = root / ".opencode/commands"
    if not commands_dir.is_dir():
        return errors

    for f in sorted(commands_dir.glob("*.md")):
        fm = parse_frontmatter(f.read_text())
        if not fm.get("description"):
            errors.append(f"commands/{f.name}: missing 'description'")

    return errors


def check_tech_paths(root: Path) -> list[str]:
    errors: list[str] = []
    tech_dir = root / ".opencode/harness/tech"
    if not tech_dir.is_dir():
        return errors

    for f in sorted(tech_dir.rglob("*.md")):
        if any(s in f.parts for s in SKIP_DIRS):
            continue
        if f.name == "README.md":
            continue
        if "common" in f.relative_to(tech_dir).parts[0]:
            continue
        fm = parse_frontmatter(f.read_text())
        if not fm.get("paths"):
            errors.append(
                f"tech/{f.relative_to(tech_dir)}: missing 'paths' frontmatter"
            )

    return errors


def check_tech_consistency(root: Path) -> list[str]:
    errors: list[str] = []
    tech_dir = root / ".opencode/harness/tech"
    detect_md = root / ".opencode/skills/init-tech-declaration/detect-tech.md"

    if not tech_dir.is_dir() or not detect_md.exists():
        return errors

    actual_dirs = {
        d.name for d in tech_dir.iterdir() if d.is_dir() and d.name != "common"
    }

    detect_text = detect_md.read_text()

    # Restrict mapping-table scan to before the "Framework hints" subsection —
    # those entries are language-qualified hints (e.g. `python (fastapi)`), not
    # standalone tech dirs.
    mapping_text = detect_text.split("#### Framework hints")[0]

    # Check: every tech dir is mentioned in detect-tech.md
    for d in sorted(actual_dirs):
        if not re.search(rf"`{re.escape(d)}`", detect_text):
            errors.append(f"tech/{d}/: not mentioned in detect-tech.md mapping tables")

    # Check: every tech-dir name in the mapping tables has a directory
    table_rows = re.findall(r"^\|.*\|.*\|", mapping_text, re.MULTILINE)
    mentioned = set()
    for row in table_rows:
        cols = [c.strip() for c in row.split("|")[1:-1]]
        if len(cols) >= 2:
            for m in re.finditer(r"`([a-z0-9][-a-z0-9]*)`", cols[1]):
                name = m.group(1)
                if name != "common":
                    mentioned.add(name)

    for name in sorted(mentioned - actual_dirs):
        if name not in ("typescript",):  # typescript is valid but shares files
            errors.append(
                f"detect-tech.md references tech dir '{name}' but no tech/{name}/ exists"
            )

    return errors


# ── main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()

    all_errors: list[str] = []
    all_errors += check_skills(root)
    all_errors += check_agents(root)
    all_errors += check_commands(root)
    all_errors += check_tech_paths(root)
    all_errors += check_tech_consistency(root)

    if all_errors:
        print(f"Lint errors ({len(all_errors)}):")
        for e in all_errors:
            print(f"  {e}")
        return 1

    checks = [
        ("skills", len(list((root / ".opencode/skills").glob("*/SKILL.md")))),
        ("agents", len(list((root / ".opencode/agents").glob("*.md")))),
        ("commands", len(list((root / ".opencode/commands").glob("*.md")))),
    ]
    summary = ", ".join(f"{n} {label}" for label, n in checks)
    print(f"OK — frontmatter valid, tech dirs consistent ({summary}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
