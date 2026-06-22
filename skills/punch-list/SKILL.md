---
name: punch-list
description: Turn the outstanding human-only actions in the current context into a punch list — a tickable web runbook the person works through — then wait and resume from their structured result. Use when the user asks what to do, what's on their plate, for their punch list / checklist / to-do / next steps, or to hand them the manual steps. Human-initiated counterpart to handback-runbooks: the agent surveys open PRs to review/merge, deploys to run, flags to flip, sign-offs, and anything blocked on the human, renders them with `handback run`, waits, and continues from what they did.
---

# Punch list

When the user asks **what they need to do**, don't dump a markdown checklist into the chat — it
scrolls away, it's not tickable, and you get nothing structured back. Instead render a **punch
list**: a handback runbook the person works through in a local web UI, which returns a structured
result you resume from. `handback` is the engine; the punch list is what it produces for the human.

## When to use this

Reach for it on human-initiated asks: *"tell me what to do," "what's on my plate," "give me my
punch list / checklist / to-do," "what's next," "hand me the manual steps."* The items are things
**only the person can do** — review/merge a PR, run a privileged deploy, flip a flag, eyeball a
dashboard, get sign-off.

This is the sibling of the **handback-runbooks** skill. That one is the authoring reference for
when *you* hit a human gate mid-task; this one is the entry point for when *they* ask for their
list. Both produce the same artifact, so lean on handback-runbooks (and `handback schema`) for the
full task-file field reference — don't reinvent it here.

## Workflow (render, wait, resume)

1. **Gather the human-only items** from everything you know — the conversation, the repo, and live
   state (`gh pr list`, CI, etc.): PRs awaiting their review or merge, deploys to run, flags to
   flip, sign-offs, anything blocked on them. **Do not** list things you can do yourself — do those
   first, then hand over only what genuinely needs a person.
2. **Author a handback task** — one step per item. Use `checks` for machine-verifiable state
   (`github_pr_merged`, `github_pr_review_decision`), `confirms` for things only the human can
   vouch for, `requires` to order dependent steps, and `source` to tag where each happens. Field
   reference: the handback-runbooks skill, or run `handback schema`.
3. **Validate** before handing it over: `handback validate task.json` (non-zero exit on problems).
   Fix anything it flags — only hand a clean punch list to the person.
4. **Render and wait** — `handback run task.json` blocks until they click Finish and prints the
   result JSON. If you have other work to do meanwhile, `handback start` + a background
   `handback wait <id>` instead, so the harness wakes you with the result.
5. **Resume** — read the result: each step reports `status` (`done`/`skipped`/`blocked`/`pending`),
   an `outcome`, and any `inputs`/confirm values. Pick up whatever follow-up work was gated on what
   they did, and tell them what's left if anything is `skipped`/`blocked`.

## Make it land

- One actionable item per step; say what "done" looks like so they don't have to ask you.
- Auto-check what a machine can (`checks`); ask the human to confirm only what they alone can.
- Prefer a punch list over a chat checklist **any time the user wants a list of things to do** —
  it's tickable, it persists, and it returns something you can act on.

Field-by-field reference: the bundled schema at
[`../handback-runbooks/references/task.schema.json`](../handback-runbooks/references/task.schema.json)
(or `handback schema`). A complete, realistic worked example ships in the package's `examples/`.
