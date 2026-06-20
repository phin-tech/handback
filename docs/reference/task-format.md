# Task format reference

The task JSON is validated by a Zod schema. Unknown keys are stripped — match field names exactly.

## Task

| Field | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. Shown in the runbook header. |
| `steps` | `Step[]` | Required. At least one step. |

## Step

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Required. Unique within the task; referenced by `requires`. |
| `title` | `string` | Required. |
| `body` | `string` | Prose instructions (newlines preserved). |
| `note` | `string` | Collapsible "from the AI" callout for context/gotchas. |
| `source` | `Source` | Where the step happens (repo or tool tag). |
| `links` | `Link[]` | Reference links. |
| `commands` | `string[]` | Shell snippets, each rendered with a copy button. |
| `requires` | `string[]` | Step ids that must be `done`/`skipped` before this one unlocks. |
| `inputs` | `Input[]` | Data to collect from the human. |
| `confirms` | `Confirm[]` | Operator tick-list (human-verified). |
| `checks` | `Check[]` | System-owned, auto-evaluated checks. |
| `paths` | `Path[]` | ≥2 alternative ways to satisfy the step. |
| `canCompleteWhen` | `"always"` \| `"checks_pass"` | Default `"always"`. |
| `autoCompleteWhen` | `"never"` \| `"checks_pass"` | Default `"never"`. Auto-marks the step done when all checks pass. |

Field ids must be unique within a step across `inputs`, `confirms`, and all paths' `confirms`.

## Source

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `"repo"` \| `"tool"` | `repo` → blue GitHub-style tag; `tool` → purple (LaunchDarkly, Slack, …) |
| `label` | `string` | E.g. `"phin-tech/orders-svc"` or `"LaunchDarkly · production"` |
| `href` | `string` | Optional URL — makes the tag a link. |

## Link

```ts
{ label: string, href: string }
```

## Input

All inputs share `id`, `label`, and optional `required`. A `required` input gates step completion.

| `kind` | Extra fields | Value type |
| --- | --- | --- |
| `text` | — | `string` |
| `textarea` | — | `string` |
| `checkbox` | — | `boolean` |
| `select` | `options: string[]` | `string` |
| `multiselect` | `options: string[]` | `string[]` |

## Confirm

```ts
{ id: string, label: string, required?: boolean }
```

A manual checkbox the operator ticks. A `required` confirm gates completion. Use for operational verification only a human can vouch for (e.g. "healthz returns 200"). Use `checks` for anything a machine can verify.

## Check

Auto-evaluated via the `gh` CLI. Both types take `id` and `label`.

| `kind` | Extra fields | Passes when |
| --- | --- | --- |
| `github_pr_merged` | `owner`, `repo`, `number` | PR state is `MERGED` |
| `github_pr_review_decision` | `owner`, `repo`, `number`, `expect?` | Review decision equals `expect` (default `APPROVED`; also `REVIEW_REQUIRED`, `CHANGES_REQUESTED`) |

A check result is `pass` / `fail` / `unavailable` (the last when `gh` isn't installed or authed).

## Path

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Required. Unique within the step. |
| `label` | `string` | Required. Shown on the segmented control. |
| `outcome` | `string` | Recorded in the result when completing on this path (e.g. `"rolled back"`). Omit for the standard/happy path. |
| `body` | `string` | Path-specific instructions. |
| `commands` | `string[]` | Path-specific commands. |
| `links` | `Link[]` | Path-specific links. |
| `confirms` | `Confirm[]` | Path-specific confirms — only the selected path's required confirms gate completion. |

The first path is the default. Selecting a path with an `outcome` and completing the step records that label instead of plain `"done"`.

## Result

Printed by `handback run` to stdout; read by the agent.

```json
{
  "sessionId": "hb_…",
  "outcome": "completed",
  "finishedAt": "2025-01-01T12:00:00.000Z",
  "reason": "optional free-text the human entered",
  "steps": [
    {
      "id": "deploy",
      "status": "done",
      "outcome": "rolled back",
      "selectedPath": "rollback",
      "inputs": {
        "healthz": true,
        "rows": "0"
      },
      "completedAt": "2025-01-01T12:00:00.000Z"
    }
  ]
}
```

`outcome` is `"completed"` only when every step is `"done"` or `"skipped"`. `inputs` carries both input values and confirm booleans, all keyed by id.
