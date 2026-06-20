# handback task format — full reference

The task JSON is validated by the Zod schema in `src/core.ts`. Unknown keys are stripped, so a
typo silently disappears — match these names exactly. Every field except `id`/`title` is
optional.

## Task

| field   | type     | notes                          |
| ------- | -------- | ------------------------------ |
| `title` | string   | required, shown in the header  |
| `steps` | Step[]   | required, at least one step    |

## Step

| field      | type        | notes                                                                 |
| ---------- | ----------- | --------------------------------------------------------------------- |
| `id`       | string      | required, unique within the task; referenced by `requires`            |
| `title`    | string      | required                                                              |
| `body`     | string      | prose instructions (rendered as paragraph text, newlines preserved)   |
| `note`     | string      | agent note — collapsible "from the AI" callout for context/gotchas    |
| `source`   | Source      | where the step happens (repo or tool tag)                             |
| `links`    | Link[]      | reference links                                                       |
| `commands` | string[]    | shell snippets, each rendered with a copy button                      |
| `requires` | string[]    | step ids that must be `done`/`skipped` before this unlocks            |
| `inputs`   | Input[]     | data to collect from the human                                        |
| `confirms` | Confirm[]   | operator tick-list (human-verified)                                   |
| `checks`   | Check[]     | system-owned, auto-evaluated checks                                   |
| `paths`    | Path[]      | ≥2 alternative ways to satisfy the step (e.g. happy path + fallback)  |
| `canCompleteWhen`  | `"always"` \| `"checks_pass"` | default `"always"`                            |
| `autoCompleteWhen` | `"never"`  \| `"checks_pass"` | default `"never"`; auto-marks the step `done` once all its checks pass |

Field ids must be unique within a step across `inputs`, `confirms`, and every path's
`confirms` (they share one value map). Path ids must be unique within the step.

## Source

| field   | type                    | notes                                         |
| ------- | ----------------------- | --------------------------------------------- |
| `kind`  | `"repo"` \| `"tool"`    | `repo` → blue GitHub-style tag; `tool` → purple (LaunchDarkly, Slack, Linear, …) |
| `label` | string                  | e.g. `"phin-tech/orders-svc"` or `"LaunchDarkly · production"` |
| `href`  | string (url)            | optional; makes the tag a link                |

## Link

`{ "label": string, "href": string (url) }`

## Input (discriminated on `kind`)

| kind          | extra fields            | value type   |
| ------------- | ----------------------- | ------------ |
| `text`        | —                       | string       |
| `textarea`    | —                       | string       |
| `checkbox`    | —                       | boolean      |
| `select`      | `options: string[]`     | string       |
| `multiselect` | `options: string[]`     | string[]     |

All inputs take `id`, `label`, and optional `required`. A `required` input gates completion
(missing = `undefined`, `false`, `""`, or empty array).

## Confirm

`{ "id": string, "label": string, "required"?: boolean }` — a manual checkbox the operator
ticks. A `required` confirm gates completion. Use for operational verification only a human can
vouch for (e.g. "healthz returns 200"); use `checks` for anything a machine can verify.

## Check (discriminated on `kind`, auto-evaluated via the `gh` CLI)

| kind                          | extra fields                          | passes when                         |
| ----------------------------- | ------------------------------------- | ----------------------------------- |
| `github_pr_merged`            | `owner`, `repo`, `number`             | the PR's state is `MERGED`          |
| `github_pr_review_decision`   | `owner`, `repo`, `number`, `expect?`  | review decision === `expect` (default `APPROVED`; also `REVIEW_REQUIRED`, `CHANGES_REQUESTED`) |

Both also take `id` and `label`. Checks evaluate on the server when the page polls; a result is
`pass` / `fail` / `unavailable` (the last when `gh` isn't installed/authed). They are
system-owned — don't phrase them as something the human ticks.

## Path

| field      | type      | notes                                                            |
| ---------- | --------- | ---------------------------------------------------------------- |
| `id`       | string    | required, unique within the step                                 |
| `label`    | string    | required, shown on the segmented switch                          |
| `outcome`  | string    | recorded in the result when the step completes on this path (e.g. `"rolled back"`); omit for the standard path |
| `body`     | string    | path-specific instructions                                       |
| `commands` | string[]  | path-specific commands                                           |
| `links`    | Link[]    | path-specific links                                              |
| `confirms` | Confirm[] | path-specific confirms — only the **selected** path's required confirms gate completion |

The first path is the default. Selecting a path with an `outcome` and completing the step
reports that label instead of plain `done`.

## Result (printed by `handback run`, read by the agent)

```json
{
  "sessionId": "hb_…",
  "outcome": "completed" | "incomplete" | "cancelled",
  "finishedAt": "ISO-8601",
  "reason": "optional free-text the human entered",
  "steps": [
    {
      "id": "deploy",
      "status": "done" | "skipped" | "blocked" | "pending",
      "outcome": "rolled back",          // path outcome if taken, else same as status
      "selectedPath": "rollback",        // which path the human chose (if any)
      "inputs": { "healthz": true, "rows": "0" },   // inputs + confirm booleans, keyed by id
      "completedAt": "…", "skippedAt": "…", "blockedAt": "…"
    }
  ]
}
```

Note `inputs` carries both input values and confirm booleans (confirms persist by their `id`).
`outcome: "completed"` only finishes when every step is `done` or `skipped`.
