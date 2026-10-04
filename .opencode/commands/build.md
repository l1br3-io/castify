---
description: Implement work incrementally — build, test, verify, commit. "auto" runs a whole prepared task list in one unattended run.
---

Load the `incremental-implementation` skill alongside `test-driven-development` with the `skill` tool, then discover the task's tech stack and load every additional skill the `Intent → skill mapping` in AGENTS.md calls for (see below).

## Where work comes from

There are no spec or chunk files. Requirements arrive from the user, the
ROADMAP's future directions, or an issue. Before building anything larger than
a bugfix, decompose it with the `planning-and-task-breakdown` skill and agree
on the task list with the user in the conversation. The durable record of what
was decided — context, decisions, deviations, outcome — is written into the
effort's **anchor commit message** at landing time (see AGENTS.md "Git is the
documentation").

## Tech-stack discovery → skill mapping

Before writing any code, work out what the task actually involves, then let the `Intent → skill mapping` in AGENTS.md decide which skills to load on top of `incremental-implementation` + `test-driven-development`.

1. **Detect the stack.** Read `Cargo.toml` and the files the task touches to pin down whether it's plain Rust logic, API routes, storage migrations, frontend React/TypeScript, or e2e.
2. **Map the intent.** Consult the `Intent → skill mapping` in AGENTS.md and load every skill the task's intent matches. For this repo that means:
   - Rust code / review → `rust-best-practices` (load for every Rust task)
   - New module boundary or public interface → `api-and-interface-design`
   - Untrusted input, auth, secrets, config → `security-and-hardening`
   - Performance-sensitive path or suspected regression → `performance-optimization`
3. **Verify unfamiliar APIs.** When the task calls an API you'd otherwise write from memory, ground it in official docs (`source-driven-development`) rather than trusting training data.

The mapping — not this file — is the authority on which skill governs an intent. If the task matches an entry listed there, load it.

## Single task (default, `/build`)

1. Pick the next task from the agreed list.
2. Load its context: the files it touches, existing patterns, and — for follow-on work — `git log --grep='<effort>'` for the effort's prior decisions.
3. Discover the task's tech stack and consult the `Intent → skill mapping` in AGENTS.md, loading every skill the task's intent matches.
4. Write a failing test for the expected behavior (RED).
5. Implement the minimum code to pass the test (GREEN).
6. Run the full test suite to check for regressions (`just ci`).
7. Commit with a descriptive message — and if this is the effort's landing commit, write the Context/Decisions/Deviations/Outcome block per AGENTS.md.

## Autonomous (`/build auto`)

Use this to collapse plan + build for a well-understood task list into one run. Every task still earns a passing test and its own commit.

1. **Require an agreed task list.** If the user hasn't agreed on scope, stop and decompose first — do not invent requirements.
2. **Establish a clean baseline.** Run `git status --porcelain`. If there are uncommitted changes, stop and ask the user to commit, stash, or confirm. Autonomous per-task commits must not absorb unrelated local work.
3. **Announce the run, then start immediately.** State the task list once so the run is visible in the transcript, then begin the task loop without waiting for approval. The stop-conditions in step 5 are the only thing that may interrupt the run.
4. **Task loop — repeat until the list is exhausted.** Run the full single-task procedure per task. After each commit, **immediately continue** — do not stop between tasks, do not ask for approval, do not summarize early. Stage only the files that task touched — never `git add -A` blindly — one commit per task so any point is a clean rollback.
5. **Stop and ask the user** (do not push through) when:
   - a test can't be made to pass or the build breaks without an obvious fix → follow `debugging-and-error-recovery`
   - the task is ambiguous, or needs a decision the user hasn't made
   - a task is high-risk or irreversible — anything touching secrets, destructive operations, or that you can't undo with `git revert` → follow `doubt-driven-development` and get explicit sign-off

   After the user resolves a blocker, they re-invoke `/build auto` — it resumes from the next task.
6. **Summarize at the end:** tasks completed, tests added, commits made, anything skipped, flagged, or left for the user — and write the effort's anchor message (Context/Decisions/Deviations/Outcome) on the landing commit.

If any step fails, follow the `debugging-and-error-recovery` skill.
