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
   [`docs/reference/task-format.md`](../../docs/reference/task-format.md)).
2. **Run it** — pick a mode (see [Two modes](#two-modes-block-or-poll-in-the-background)
   below): `handback run task.json` to block inline, or `handback start task.json` plus a
   background poller so you can keep working while the human does the runbook.
3. **Optionally pre-populate inputs** using `handback tee` — pipe a script's output directly
   into a step's input field so the operator sees it pre-filled rather than having to copy-paste:
   ```bash
   SESSION=$(handback start release.json | jq -r .sessionId)
   ./deploy.sh | handback tee $SESSION deploy output
   handback wait $SESSION
   ```
4. Read the result: each step reports `status` (`done` / `skipped` / `blocked` / `pending`),
   an `outcome` (the path's label when a fallback path was taken, else the status), any
   `inputs`/confirm values the human entered, and `selectedPath`. Resume accordingly.

## Two modes: block, or poll in the background

Both modes open the same UI and produce the same result JSON. Choose by whether you have other
work to do while the human works the runbook.

**Blocking** — `handback run task.json`. The command stays in the foreground and exits when the
human clicks Finish, printing the result JSON to stdout (the `{sessionId, url, token}` line goes
to stderr). Use this when the handback is the only thing left to do and waiting is fine.

**Background** — start the session, then poll with a shell command, the same way you'd background
a long build or a `git` fetch and get woken when it finishes:

```bash
SESSION=$(handback start task.json | jq -r .sessionId)
handback wait "$SESSION"   # run in the background: blocks, then prints the result JSON
```

`handback start` returns immediately with `{sessionId, url, token}`. `handback wait <id>` is the
poller — a blocking shell command that sits until the human finishes and then prints the result
to stdout. Launch it as a **background command** so the harness wakes you with the result while
you carry on with other work; don't busy-loop it yourself. If you just want a one-shot,
non-blocking peek at progress instead of a blocking wait, `handback status <id>` prints the
current session state and exits.

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
  links. Pair a command with a `handback tee` invocation so the operator can run it and have
  the output land in the field automatically — no manual copy-paste.

  **Short output** (a few lines, a JSON blob, an ID): use a `textarea` and pipe straight into
  the input. The content is stored in the result JSON and the agent can read it inline:
  ```json
  {
    "id": "deploy",
    "title": "Run the deploy",
    "commands": ["./deploy.sh | handback tee $SESSION_ID deploy output"],
    "inputs": [{ "id": "output", "label": "Deploy output", "kind": "textarea" }]
  }
  ```

  **Large output** (full build logs, test runs, verbose traces): use `--file` and a `text`
  input. The content is written to disk; only the file path goes into the result JSON. The
  agent reads the file directly after the handback returns:
  ```json
  {
    "id": "run-tests",
    "title": "Run the test suite",
    "commands": ["npm test | handback tee $SESSION_ID run-tests log --file /tmp/test.log"],
    "inputs": [{ "id": "log", "label": "Test log path", "kind": "text" }]
  }
  ```
  The agent then does `fs.readFile(result.steps.find(s => s.id === 'run-tests').inputs.log)`
  to get the full output.

## Rules of thumb

- One job per step; order them so blockers come first and add `requires`.
- Auto-check what a machine can (`checks`); ask the human to confirm what only they can
  (`confirms`). Don't make the human tick something the system already verifies.
- Write `note`/`body`/`label` as plain instructions to the operator — say what to do and what
  "good" looks like. The human shouldn't have to infer intent.
- Every field except `id`/`title` is optional. Add only what the step needs.

A complete, realistic example using every feature lives at
[`examples/cross-service-release.json`](../../examples/cross-service-release.json).
Full field-by-field reference: [`docs/reference/task-format.md`](../../docs/reference/task-format.md).
