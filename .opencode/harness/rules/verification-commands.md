# Verification Commands

How to run lint, test, and build commands during a session without bloating
the main context. Apply during RED→GREEN loops and to every verification step
in `incremental-implementation`, `test-driven-development`,
`debugging-and-error-recovery`, `git-workflow-and-versioning`, and the
`/build`, `/test`, `/review`, and `/ship` commands.

Verification command output flows into the calling context. In long sessions
that cost compounds: a 5KB test run carried across ten turns is 50KB paid for
every subsequent turn. The harness's stance is *verify with evidence, but keep
the output bounded*.

## The four rules

### 1. Exit code is the verdict

Zero exit status = green. Non-zero = red. Never parse prose to decide whether
a command passed. The exit code is structured, reliable, and present for every
well-behaved tool. Read it, trust it, move on.

```bash
pytest -q --tb=short -x
echo $?   # 0 = green, non-zero = red
```

### 2. Quiet by default

Use the tool's quiet flag so *success* noise is suppressed but *failure*
detail is preserved. That is what `-q` modes are designed to do — they drop
the dots, the progress bars, the "Ran 432 tests in 12.3s" banners, and keep
the tracebacks, the assertion diffs, the file:line citations.

| Tool     | Quiet command                | What you keep on failure                |
| -------- | ---------------------------- | --------------------------------------- |
| pytest   | `pytest -q --tb=short -x`    | short traceback for first failure       |
| eslint   | `eslint --quiet`             | warnings and errors only                |
| tsc      | `tsc --noEmit`               | already minimal                         |
| cargo    | `cargo test --quiet`         | pass/fail per test, failure output      |
| go       | `go test ./...`              | quiet by default, failures shown        |
| ruff     | `ruff check .`               | concise list of violations              |
| jest     | `jest --silent`              | dots only; failures still printed       |
| vitest   | `vitest run --reporter=dot`  | dots; failures still printed            |
| dotnet   | `dotnet test --nologo`       | minimal banner, failures shown          |
| rspec    | `rspec -p`                   | progress format                         |
| rubocop  | `rubocop`                    | concise by default                      |
| phpunit  | `phpunit --no-output`        | failures only                           |
| flutter  | `flutter test`               | concise pass/fail per test              |
| swift    | `swift test --quiet`         | failures only                           |

The principle generalizes: reach for the flag that trades success verbosity
for signal. If the project's test runner has a `--quiet`, `--silent`,
`--reporter=dot`, or `-p` mode, that is almost always the right default for
agent-driven runs.

### 3. Fail fast while iterating

During RED→GREEN you can only fix one failure at a time. There is no value
in paying context for twenty stacked failures. Stop at the first:

```bash
pytest -x            # stop on first failure
jest --bail          # stop after first failed test suite
cargo test --        # passes --no-fail-fast=false if configured
go test -failfast    # stop on first failing package
```

Get one failure, read it, fix it, re-run. Repeat. Full-suite verification
belongs at the *end* of the loop, not inside it.

### 4. Redirect-and-grep for huge output

When a single command will exceed the inline truncation threshold (~2000
lines or 51KB), redirect to a file and let the agent pull only matching
lines into context. The Bash tool already truncates and writes the full
output to a file when it overflows — this rule just makes that explicit and
lets you *aim* the grep up front.

```bash
# Run quietly, capture everything to a file, surface only the verdict
pytest -q > /tmp/verify.out 2>&1
echo $?
# Then Grep the file for the specific failure pattern:
#   Grep "^FAILED\|^ERROR\|Error:" /tmp/verify.out
```

This is the right move for full regression suites, large lint sweeps, and
builds with hundreds of diagnostics. The exit code is the verdict; the file
is the evidence the agent consults on demand.

## When to inline vs isolate

- **Inline** for verification commands. Output is bounded, the agent needs
  the specific failures, and the Bash tool truncates the worst case
  automatically.
- **Subagent** only for exploratory reads — grepping fifty files, auditing
  a whole directory, "find every call site of X." See
  `.opencode/harness/rules/orchestration-patterns.md` Pattern 5 (Research isolation). A
  subagent round-trip for a one-shot `pytest -q` is more expensive than
  the inline run it replaces.

## How to apply

- **Per increment:** run the relevant quiet command after each code change
  that could affect it (see `incremental-implementation`).
- **Per task:** run the full suite quietly as the closing gate.
- **Don't repeat unchanged verifications.** After a green run, re-running
  the same command on unchanged code adds no information and pays its
  output cost again. Re-run after the next edit, not as reassurance.

## Red flags

- Running `pytest` (no flags) inside a RED→GREEN loop — every iteration
  pays for the full success banner plus every stacked failure.
- Re-running the build "just to be sure" when nothing has changed since
  the last green run.
- Spawning a subagent to run a single lint command — adds latency and
  reasoning tokens for no context savings.
- Parsing command prose ("looks like it passed") instead of checking the
  exit code.
- Letting verbose CI-style output flow into the main session when a
  `-q` flag would have carried the same signal in a tenth of the tokens.
