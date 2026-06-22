# handback

Hand control from an agent to a human, then pick it back up.

When an automated agent hits a step that needs a person — review and merge a PR, run a
privileged deploy, flip a production flag, get sign-off — `handback` renders a **runbook** the
human works through in a local web UI, then prints a structured result the agent reads to
resume.

It's a single local session: a CLI spins up a server on `127.0.0.1`, opens your browser to a
one-column checklist, and blocks until you click **Finish**.

## Install

```bash
npm install -g handback     # or run ad-hoc with: npx handback <command>
```

Some checks shell out to the [GitHub CLI](https://cli.github.com/) (`gh`), so install and
`gh auth login` if your runbooks use GitHub checks.

## Quick start

Write a task (a runbook of ordered steps):

```json
{
  "title": "Ship the release",
  "steps": [
    {
      "id": "review",
      "title": "Review & merge the PR",
      "source": { "kind": "repo", "label": "phin-tech/app", "href": "https://github.com/phin-tech/app/pull/42" },
      "checks": [
        { "id": "merged", "label": "phin-tech/app#42 is merged", "kind": "github_pr_merged", "owner": "phin-tech", "repo": "app", "number": 42 }
      ],
      "confirms": [{ "id": "smoke", "label": "Smoke-tested staging", "required": true }]
    },
    {
      "id": "deploy",
      "title": "Run the deploy",
      "requires": ["review"],
      "commands": ["./deploy --env production"],
      "inputs": [{ "id": "output", "label": "Deploy output", "kind": "textarea", "required": true }]
    }
  ]
}
```

Run it:

```bash
handback run task.json
```

Your browser opens the runbook. Work top to bottom — tick the checkbox to complete a step,
fill in confirms/inputs, follow `requires` ordering (later steps stay locked until their
blockers are done). Click **Finish** and the command prints the result to stdout:

```json
{
  "sessionId": "hb_…",
  "outcome": "completed",
  "steps": [
    { "id": "review", "status": "done", "outcome": "done", "inputs": { "smoke": true } },
    { "id": "deploy", "status": "done", "outcome": "done", "inputs": { "output": "…" } }
  ]
}
```

## What you can put in a step

| Piece        | What it's for                                                                 |
| ------------ | ----------------------------------------------------------------------------- |
| `body`       | Prose instructions for the operator                                           |
| `note`       | A collapsible **agent note** — context/gotchas from the AI                     |
| `source`     | A tag for where the step happens — `repo` (GitHub) or `tool` (LaunchDarkly, Slack, …) |
| `requires`   | Step ids that gate this one — shows a **"blocked by N"** chip until they're done |
| `checks`     | System-owned auto checks: `github_pr_merged`, `github_pr_review_decision`      |
| `confirms`   | Operator tick-list — things only a human can vouch for (a `required` one gates completion) |
| `inputs`     | Data to collect — `text` / `textarea` / `select` / `multiselect` / `checkbox`  |
| `paths`      | Alternative/fallback routes (e.g. ship vs. roll back); records which one was taken |
| `commands` / `links` | Shell snippets (with copy button) and reference links                 |

Full field-by-field reference:
[`docs/reference/task-format.md`](docs/reference/task-format.md).
A complete, realistic example: [`examples/cross-service-release.json`](examples/cross-service-release.json).
A machine-readable JSON Schema ships at [`schema/task.schema.json`](schema/task.schema.json) —
reference it via `$schema` for editor autocomplete, and run `handback validate` before `run`.

## CLI

```
handback run <task.json>      Start a session, block until finish, print the result JSON
handback start <task.json>    Start a session, print { sessionId, url, token }, return now
handback wait <session-id>    Block until a started session finishes, print its result
handback status <session-id>  Print a session (token redacted)
handback open <session-id>    Open a session's URL in the browser
handback list                 List sessions
handback validate <task.json> Check a task file (fields, requires, includes); non-zero on failure
handback schema               Print the task-file JSON Schema to stdout
handback doctor [task.json]   Print setup hints, or validate a task file if one is given
```

Sessions persist as JSON under `~/.handback/sessions/` (override the base dir with
`HANDBACK_HOME`). Set `HANDBACK_OPEN=0` to skip auto-opening the browser.

## Authoring skill

This repo ships an installable [Agent Skill](https://skills.sh) that teaches an agent to write
good handback runbooks:

```bash
npx skills add phin-tech/handback
```

Installed CLI users can also run `handback doctor` to print this command.

## Development

```bash
npm install
npm run dev      # Vite dev server for the UI
npm run build    # tsc + vite → dist/
npm test         # node:test suite
npm run check    # svelte-check
```

- `src/` — the Node backend: `core.ts` (Zod task schema + session state), `checks.ts` (gh-based
  checks), `server.ts` (HTTP API + static UI), `cli.ts` (entrypoint), `session-store.ts`.
- `ui/` — the Svelte 5 single-page runbook.
- `examples/`, `test/`, `skills/`.

## License

[MIT](LICENSE)
