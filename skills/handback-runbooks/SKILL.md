---
name: handback-runbooks
description: Author handback task JSON to hand a job back to a human. Use when an agent hits a step that needs a person — review/merge a PR, run a deploy, flip a flag, get sign-off — and you want to render a runbook the human works through, then resume from their structured result. Covers steps, dependencies, the "PR is merged" check, operator confirms, agent notes, non-GitHub sources, and fallback paths.
---

# Authoring handback runbooks

`handback` hands control from an agent to a human. You write a **task** (a JSON runbook of
ordered steps); `handback run task.json` opens a local web UI where the human works each step
and clicks Finish; the command then prints a structured **result** to stdout that you read to
resume. Design the runbook so a human can do it top-to-bottom without asking you questions.

## When to use this

Reach for handback when a step needs human judgment or human-only access: approving/merging a
PR, running a privileged deploy, flipping a production flag, eyeballing a dashboard, getting
sign-off. Don't use it for work the agent can do itself.

## Workflow

1. Write a task JSON file (see shape below; full reference in
   [references/task-format.md](references/task-format.md)).
2. Run it: `handback run task.json` — blocks until the human finishes, then prints the result
   JSON. (`handback start task.json` returns immediately with `{sessionId, url, token}` if you
   want to poll with `handback wait <id>` instead.)
3. Read the result: each step reports `status` (`done` / `skipped` / `blocked` / `pending`),
   an `outcome` (the path's label when a fallback path was taken, else the status), any
   `inputs`/confirm values the human entered, and `selectedPath`. Resume accordingly.

## Minimal task

```json
{
  "title": "Release handback",
  "steps": [
    { "id": "review", "title": "Review the PR", "body": "Open the PR and leave a decision." }
  ]
}
```

## The pieces (compose only what the step needs)

- **Ordering & dependencies** — list `requires: ["other-step-id"]`. The UI shows a
  **"blocked by N"** chip and greys the step out until its blockers are `done`/`skipped`, then
  unlocks it. Steps still run in listed order; `requires` just gates and documents *why*.
- **`source`** — where the step happens, as a tag: `{ "kind": "repo", "label":
  "phin-tech/orders-svc", "href": "…" }` (blue) or `{ "kind": "tool", "label": "LaunchDarkly ·
  production" }` (purple, for non-GitHub systems like LaunchDarkly / Slack / Linear).
- **`note`** — optional instructions/context *from you, the agent*, shown behind a collapsible
  "agent note" pill. Put the "why" and the gotchas here (ramp guidance, rollback safety, etc.).
- **`checks`** — system-owned, auto-evaluated. Use `github_pr_merged` to assert a PR has
  landed; `github_pr_review_decision` to assert a review state. These are **not** for the human
  to tick — they verify themselves. Label them plainly, e.g. `"phin-tech/orders-svc#88 is
  merged"`.
- **`confirms`** — operator tick-list: things only a human can vouch for, e.g. `{ "id":
  "healthz", "label": "orders /healthz returns 200 after rollout", "required": true }`. A
  `required` confirm gates completion. Use these for operational verification (the operator
  checks it, not an automated check).
- **`inputs`** — data you want back: `text`, `textarea`, `select`/`multiselect` (with
  `options`), `checkbox`. Mark `required: true` to gate completion.
- **`paths`** — alternative/fallback ways to satisfy one step (a happy path and a rollback). A
  segmented switch swaps the instructions; each path can carry its own `body`/`commands`/
  `links`/`confirms`. Give the fallback an `outcome` (e.g. `"rolled back"`) so the result
  records which route the human took. Needs ≥2 paths.
- **`commands`** / **`links`** — shell snippets (rendered with a copy button) and reference
  links.

## Rules of thumb

- One job per step; order them so blockers come first and add `requires`.
- Auto-check what a machine can (`checks`); ask the human to confirm what only they can
  (`confirms`). Don't make the human tick something the system already verifies.
- Write `note`/`body`/`label` as plain instructions to the operator — say what to do and what
  "good" looks like. The human shouldn't have to infer intent.
- Every field except `id`/`title` is optional. Add only what the step needs.

A complete, realistic example using every feature lives at
[references/cross-service-release.json](references/cross-service-release.json).
Full field-by-field reference: [references/task-format.md](references/task-format.md).
