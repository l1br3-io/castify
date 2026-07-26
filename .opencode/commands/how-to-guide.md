---
description: Conversational FAQ — ask about workflow, artifacts, phases, methodology fit, or resuming work
---

# /how-to-guide

A conversational guide. The reference at
`.opencode/harness/references/how-to-guide.md` holds the consolidated answers;
this command picks the right slice by talking to the user — never dumps the
whole file.

## Flow

1. **Ask what they want to explore.** Offer the categories (one line each),
   then wait for the user to pick one, ask a specific question, or type their
   own:
    - **Resuming work** — coming back after a break, forgot where I was
    - **Artifacts & files** — what `spec.md` / `plan.md` / `todo.md` / `tasks/`
      are for
    - **Phases & tasks** — what an "effort" means, vertical vs horizontal slicing
    - **Methodology & fit** — agile-coupled? project-agnostic? OSS-friendly?
    - **Conventions** — commit messages, status source, where ROADMAP/VISION fit

2. **Read the matching section** from the reference. Do NOT paste it verbatim —
   re-explain in your own words, adapt to what the user already knows (ask if
   unsure), and use their project's actual files (`docs/specs/<effort-slug>/todo.md`,
   current `spec.md`, shipped efforts) as concrete examples where useful.

3. **End every answer with a follow-up offer**, e.g.:
   - "Want to go deeper on X?"
   - "Should I show what this looks like in your repo right now?"
   - "Want the related topic on Y?"

4. **Off-script questions** — if the user's question doesn't match a category,
   scan the reference's table of contents, pick the closest entry, and adapt.
   The reference is a starting point, not a script. If nothing fits, answer
   directly from the harness's own files and offer to add the topic to the
   reference.

5. **Stop when the user signals they're done.** Do not enumerate every entry
   upfront — the conversation is the value, not a data dump.
