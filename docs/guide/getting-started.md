# Getting started

## Install

```bash
npm install -g handback
```

Or run ad-hoc without installing:

```bash
npx handback run task.json
```

Some checks shell out to the [GitHub CLI](https://cli.github.com/) (`gh`). Install and run `gh auth login` if your runbooks use GitHub checks.

## Quick start

Write a task file — a JSON runbook of ordered steps:

```json
{
  "title": "Ship the release",
  "steps": [
    {
      "id": "review",
      "title": "Review & merge the PR",
      "source": {
        "kind": "repo",
        "label": "phin-tech/app",
        "href": "https://github.com/phin-tech/app/pull/42"
      },
      "checks": [
        {
          "id": "merged",
          "label": "phin-tech/app#42 is merged",
          "kind": "github_pr_merged",
          "owner": "phin-tech",
          "repo": "app",
          "number": 42
        }
      ],
      "confirms": [
        { "id": "smoke", "label": "Smoke-tested staging", "required": true }
      ]
    },
    {
      "id": "deploy",
      "title": "Run the deploy",
      "requires": ["review"],
      "commands": ["./deploy --env production"],
      "inputs": [
        { "id": "output", "label": "Deploy output", "kind": "textarea", "required": true }
      ]
    }
  ]
}
```

Run it:

```bash
handback run task.json
```

handback starts a local server, opens your browser to the runbook, and **blocks until you click Finish**.

Work through the steps top to bottom. Steps with `requires` stay locked until their blockers are done. When you click **Finish**, the command prints the result JSON to stdout:

```json
{
  "sessionId": "hb_…",
  "outcome": "completed",
  "finishedAt": "2025-01-01T12:00:00.000Z",
  "steps": [
    {
      "id": "review",
      "status": "done",
      "outcome": "done",
      "inputs": { "smoke": true }
    },
    {
      "id": "deploy",
      "status": "done",
      "outcome": "done",
      "inputs": { "output": "Deployed 3 instances…" }
    }
  ]
}
```

The agent reads this and resumes.

## What goes in a step

| Piece | What it's for |
| --- | --- |
| `body` | Prose instructions for the operator |
| `note` | A collapsible agent note — context/gotchas from the AI |
| `source` | Where the step happens — `repo` (GitHub) or `tool` (LaunchDarkly, Slack, …) |
| `requires` | Step ids that gate this one — shows a **"blocked by N"** chip until they're done |
| `checks` | System-owned auto checks: `github_pr_merged`, `github_pr_review_decision` |
| `confirms` | Operator tick-list — things only a human can vouch for |
| `inputs` | Data to collect — `text` / `textarea` / `select` / `multiselect` / `checkbox` |
| `paths` | Alternative/fallback routes; records which one was taken |
| `commands` / `links` | Shell snippets (with copy button) and reference links |

See the full [task format reference](/reference/task-format) for every field and type.

## Agent skill

This repo ships an installable [Agent Skill](https://skills.sh) that teaches an AI agent to write good handback runbooks:

```bash
npx skills add phin-tech/handback
```

Installed CLI users can also run `handback doctor` to print this command.

## Sessions

Sessions persist as JSON under `~/.handback/sessions/` (override with `HANDBACK_HOME`). Set `HANDBACK_OPEN=0` to skip auto-opening the browser.
