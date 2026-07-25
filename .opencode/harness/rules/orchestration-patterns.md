# Orchestration Patterns

Reference catalog of agent orchestration patterns this repo endorses, plus anti-patterns to avoid. Read this before adding a new slash command that coordinates multiple personas, or before introducing a new persona that "wraps" existing ones.

The governing rule: **the user (or a slash command) is the orchestrator. Personas do not invoke other personas.** Skills are mandatory hops inside a persona's workflow.

---

## Endorsed patterns

### 1. Direct invocation (no orchestration)

Single persona, single perspective, single artifact. The default and the cheapest option.

```
user → code-reviewer → report → user
```

**Use when:** the work is one perspective on one artifact and you can describe it in one sentence.

**Examples:**
- "Review this PR" → `code-reviewer`
- "Find security issues in `auth.ts`" → `security-auditor`
- "What tests are missing for the checkout flow?" → `test-engineer`

**Cost:** one round trip. The baseline you should always compare orchestrated patterns against.

---

### 2. Single-persona slash command

A slash command that wraps one persona with the project's skills. Saves the user from re-explaining the workflow every time.

```
/review → code-reviewer (with code-review-and-quality skill) → report
```

**Use when:** the same single-persona invocation happens repeatedly with the same setup.

**Examples in this repo:** `/review`, `/test`, `/code-simplify`.

**Cost:** same as direct invocation. The slash command is just a saved prompt.

**Anti-signal:** if the slash command's body is mostly "decide which persona to call," delete it and let the user call the persona directly.

---

### 3. Parallel fan-out with merge

Multiple personas operate on the same input concurrently, each producing an independent report. A merge step (in the main agent's context) synthesizes them into a single decision.

```
                    ┌─→ code-reviewer    ─┐
/ship → fan out  ───┼─→ security-auditor ─┤→ merge → go/no-go + rollback
                    └─→ test-engineer    ─┘
```

**Use when:**
- The sub-tasks are genuinely independent (no shared mutable state, no ordering dependency)
- Each sub-agent benefits from its own context window
- The merge step is small enough to stay in the main context
- Wall-clock latency matters

**Examples in this repo:** `/ship`, `/webperf`.

**Cost:** N parallel sub-agent contexts + one merge turn. Higher than direct invocation, but faster wall-clock and produces better reports because each sub-agent stays focused on its single perspective.

**Validation checklist before adopting this pattern:**
- [ ] Can I run all sub-agents at the same time without ordering issues?
- [ ] Does each persona produce a different *kind* of finding, not just the same finding from a different angle?
- [ ] Will the merge step fit in the main agent's remaining context?
- [ ] Is the user's wait time long enough that parallelism is actually noticeable?

If any answer is "no," fall back to direct invocation or a single-persona command.

---

### 4. Sequential pipeline as user-driven slash commands

The user runs slash commands in a defined order, carrying context (or commit history) between them. There is no orchestrator agent — the user IS the orchestrator.

```
user runs:  /spec  →  /planning  →  /build  →  /test  →  /review  →  /ship
```

**Use when:** the workflow has dependencies (each step needs the previous step's output) and human judgment between steps adds value.

**Examples in this repo:** the entire DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP lifecycle (`/spec`, `/planning`, `/build`, `/test`, `/review`, `/ship`).

**Cost:** one sub-agent context per step. Free for the orchestration layer because there is no orchestrator agent.

**Why not automate it:** an LLM "lifecycle orchestrator" would (a) lose nuance between steps because it has to summarize for hand-off, (b) skip the human checkpoints that catch wrong-direction work early, and (c) double the token cost via paraphrasing turns.

---

### 5. Research isolation (context preservation)

When a task requires reading large amounts of material that shouldn't pollute the main context, spawn a research sub-agent that returns only a digest.

```
main agent → research sub-agent (reads 50 files) → digest → main agent continues
```

**Use when:**
- The main session needs to stay focused on a downstream task
- The investigation result is much smaller than the input it consumes
- The decision quality benefits from the main agent having room to think after

**Examples:** "Find every call site of this deprecated API across the monorepo," "Summarize what these 30 ADRs say about caching."

**Cost:** one isolated sub-agent context. Worth it any time the alternative is loading hundreds of files into the main context.

**In opencode, use the built-in `explore` subagent type** (via the Task tool) rather than defining a custom research persona. `explore` is purpose-built for read-only codebase search and analysis — fast, no write/edit tools, exactly this pattern. Define a custom research subagent only when `explore` doesn't fit (e.g. you need a domain-specific system prompt the model wouldn't infer).

---

## opencode compatibility

This catalog is harness-agnostic in spirit, but this repo targets opencode. Here's how each pattern maps onto opencode's primitives — and where the platform enforces our rules for us.

### Where personas live

opencode auto-discovers `.opencode/agents/*.md` by convention — no per-file registration, no plugin manifest. So `.opencode/agents/code-reviewer.md`, `.opencode/agents/security-auditor.md`, `.opencode/agents/test-engineer.md`, and `.opencode/agents/web-performance-auditor.md` are picked up automatically when opencode starts. Drop a new `.opencode/agents/<name>.md` in, restart, and it's available. Same convention applies to `.opencode/commands/*.md` and `.opencode/skills/*/SKILL.md`.

### Subagents are the only fan-out primitive

opencode has one parallelism mechanism for this catalog: **subagents**. Pattern 3 (parallel fan-out with merge) maps to it directly. There is no separate "teammates that message each other" primitive — if you find yourself wanting one, see the "competing-hypothesis debugging" note below for how to fake the effect within the subagent model.

Each `.opencode/agents/*.md` with `mode: subagent` is exposed by the CLI as a **tool with the same name**. That's what lets `/ship` and `/webperf` fan out: `code-reviewer.md` becomes a `code-reviewer` tool the main agent can call, and `@code-reviewer` works as an explicit invocation. Subagents run in isolated context loops and return only their final report to the calling session.

### Platform-enforced rules

opencode's subagent model enforces parts of this catalog by construction:

- **Subagents don't recurse arbitrarily.** A subagent is a tool the main agent invokes; the orchestration layer stays in the main session. Anti-pattern B (persona-calls-persona) and Anti-pattern D (deep persona trees) have no natural home in this model — if you try to build them, you end up reimplementing orchestration in the main agent anyway.
- **Merge happens in the main context.** Subagents can't talk to each other, only report back. So Pattern 3's merge step *must* live in the main session — there's nowhere else it could go.

This means the anti-patterns below are hard to stumble into by accident: the platform's shape pushes you toward the endorsed patterns.

### Built-in subagent types to know about

Before defining a custom subagent, check whether one of opencode's built-in Task-tool subagent types covers the role:

| Built-in | Purpose |
|----------|---------|
| `explore` | Read-only codebase search and analysis. Use this for Pattern 5 (research isolation). |
| `general` | Multi-step tasks needing both exploration and modification. |

Don't redefine these. Layer your specialist personas (code-reviewer, security-auditor, test-engineer, web-performance-auditor) on top of them.

### Agent frontmatter

Agent files use a small frontmatter schema. The fields this repo relies on:

- `name` — must match the filename (without `.md`).
- `description` — when-to-use summary; surfaces the agent as a candidate to the main agent.
- `mode: subagent` — required for fan-out personas. Without it the file is a regular agent, not a callable tool.

The file body becomes the agent's system prompt. opencode loads `mcpServers` from project and user config (`.opencode.jsonc`, `~/.config/opencode/`) at the session level — personas pick them up automatically; they are not per-agent frontmatter fields.

### Spawning multiple subagents in parallel

In opencode, parallel fan-out (Pattern 3) requires issuing **multiple Task tool calls in a single assistant turn**. Sequential turns serialize execution. `/ship` and `/webperf` call this out explicitly. Any new orchestrator command should do the same.

---

## Worked example: competing-hypothesis debugging (within the subagent model)

This example shows how to approximate an "adversarial debate" investigation using only opencode's subagent primitive — no team/coordinator layer. It's the pattern to reach for when a single agent will pick the first plausible theory and stop, but you don't need teammates that message each other in real time.

### The scenario

> *Checkout occasionally hangs for ~30 seconds before completing. It happens roughly once every 50 sessions. No errors in logs. Started after last week's release.*

Plausible root causes (mutually exclusive, all fit the symptoms):

1. A race condition in the new payment-confirmation flow
2. An auth check that occasionally falls through to a slow synchronous network call
3. A missing index on a query that scales with cart size
4. A flaky third-party API where the SDK retries silently before timing out

### Why this is *not* a `/ship` job

| | `/ship` (parallel subagents) | This pattern (sequential adversarial passes) |
|--|------------------------------|----------------------------------------------|
| Sub-agents see | The same diff, different lenses | The previous round's leading theory, asked to falsify it |
| Output | Three independent reports → one merge | Converged root cause through disproven hypotheses |
| Right when | You want a verdict on a known artifact | You want to *find* the artifact among hypotheses |

`/ship` is a verdict; this is an investigation.

### The trigger prompt

Type into the main session, in natural language:

```
Users report checkout hangs for ~30 seconds intermittently after last
week's release. No errors in logs.

Investigate with competing hypotheses. Run three passes, each a
subagent call, feeding each pass the previous pass's leading theory
and asking it to disprove it:

  Pass 1 — code-reviewer lens: race conditions and blocking calls in
           the checkout code path. Output the most likely theory + the
           evidence that supports it.
  Pass 2 — security-auditor lens: given pass 1's theory, try to
           disprove it by checking auth checks, session handling, and
           recent synchronous network calls. Either corroborate or
           propose the strongest alternative.
  Pass 3 — test-engineer lens: given the surviving theory, propose the
           minimal test that would confirm or refute it, and check
           coverage gaps in checkout that let this slip through.

Only converge when two passes agree on the same root cause.
```

### What happens

1. Each pass is one subagent call in its own context window, focused on a single lens.
2. The main agent carries one theory forward between passes — that's the only hand-off state, and it's small.
3. Because each pass is told to *disprove* the prior theory, the survivor is much more likely to be the real root cause than the first plausible guess.
4. The main agent synthesizes the converged theory and presents it.

### When to clean up

No team to clean up — each pass is stateless and returns to the main session. When the investigation lands on a root cause, you're done.

### Cost expectation

Three sequential subagent passes cost more than one direct invocation but less than a long single-agent investigation that loads everything into one context. The justification is *quality of conclusion* — for production debugging where the wrong fix is expensive, the extra passes are a bargain. For a routine PR review, stick with `/ship`.

### Anti-pattern in this scenario

Do **not** rebuild this as a `/debug` slash command that fans out subagents in parallel. Parallel subagents can't see each other's findings, so you'd get three independent guesses instead of a converging investigation. The pattern only works because the passes are **sequential and adversarial**. If a workflow keeps coming up, save the trigger prompt above as a snippet rather than wrapping it in a slash command that misuses parallel fan-out.

### When *not* to use this pattern

- Production-bound verdict on a known diff → use `/ship` (parallel subagents).
- One specialist perspective on one artifact → direct persona invocation.
- Sequential lifecycle (spec → plan → build) → user-driven slash commands (Pattern 4).
- Read-heavy research with a small digest → built-in `explore` subagent.

Reach for this pattern only when a single agent would settle on the first plausible theory and stop.

---

## Anti-patterns

### A. Router persona ("meta-orchestrator")

A persona whose job is to decide which other persona to call.

```
/work → router-persona → "this needs a review" → code-reviewer → router (paraphrases) → user
```

**Why it fails:**
- Pure routing layer with no domain value
- Adds two paraphrasing hops → information loss + roughly 2× token cost
- The user already knew they wanted a review; they could have called `/review` directly
- Replicates the work that slash commands and intent mapping in `AGENTS.md` already do

**What to do instead:** add or refine slash commands. Document intent → command mapping in `AGENTS.md`.

---

### B. Persona that calls another persona

A `code-reviewer` that internally invokes `security-auditor` when it sees auth code.

**Why it fails:**
- Personas were designed to produce a single perspective; chaining them defeats that
- The summary the calling persona passes loses context the called persona needs
- Failure modes multiply (which persona's output format wins? whose rules apply?)
- Hides cost from the user

**What to do instead:** have the calling persona *recommend* a follow-up audit in its report. The user or a slash command runs the second pass.

---

### C. Sequential orchestrator that paraphrases

An agent that calls `/spec`, then `/planning`, then `/build`, etc. on the user's behalf.

**Why it fails:**
- Loses the human checkpoints that catch wrong-direction work
- Each hand-off summarizes context — accumulated drift over a long pipeline
- Doubles token cost: orchestrator turn + sub-agent turn for every step
- Removes user agency at exactly the points where judgment matters most

**What to do instead:** keep the user as the orchestrator. Document the recommended sequence in `README.md` and let users invoke it.

---

### D. Deep persona trees

`/ship` calls a `pre-ship-coordinator` that calls a `quality-coordinator` that calls `code-reviewer`.

**Why it fails:**
- Each layer adds latency and tokens with no decision value
- Debugging becomes a multi-level investigation
- The leaf personas lose context to multiple summarization steps

**What to do instead:** keep the orchestration depth at most 1 (slash command → personas). The merge happens in the main agent.

---

## Decision flow

When considering a new orchestrated workflow, walk this flow:

```
Is the work one perspective on one artifact?
├── Yes → Direct invocation. Stop.
└── No  → Will the same composition repeat?
         ├── No  → Direct invocation, ad hoc. Stop.
         └── Yes → Are sub-tasks independent?
                  ├── No  → Sequential slash commands run by user (Pattern 4).
                  └── Yes → Parallel fan-out with merge (Pattern 3).
                           Validate against the checklist above.
                           If any check fails → fall back to single-persona command (Pattern 2).
```

---

## When to add a new pattern to this catalog

Add a new entry only after:

1. You've used the pattern at least twice in real work
2. You can name a concrete artifact in this repo that demonstrates it
3. You can explain why an existing pattern wouldn't have worked
4. You can describe its anti-pattern shadow (what people will mistakenly build instead)

Premature catalog entries become aspirational documentation that no one follows.
