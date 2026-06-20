# Writing runbooks

A handback runbook is a JSON file that describes a multi-step process a human must carry out. This page covers patterns and best practices.

## Step anatomy

Every step needs an `id` and `title`. Everything else is optional and composes:

```json
{
  "id": "deploy",
  "title": "Run the deploy",
  "body": "Use the deploy script with the production flag. It takes about 3 minutes.",
  "note": "The previous deploy had a DB migration — watch the logs for 'migration complete' before declaring success.",
  "source": { "kind": "tool", "label": "Argo CD · production" },
  "commands": ["./deploy --env production --verbose"],
  "links": [
    { "label": "Argo CD dashboard", "href": "https://argo.example.com" }
  ],
  "requires": ["review"],
  "checks": [
    { "id": "pr_merged", "label": "PR #42 is merged", "kind": "github_pr_merged", "owner": "acme", "repo": "app", "number": 42 }
  ],
  "confirms": [
    { "id": "healthz", "label": "healthz returns 200", "required": true }
  ],
  "inputs": [
    { "id": "deploy_url", "label": "Deploy URL", "kind": "text", "required": true }
  ]
}
```

## Checks vs. confirms

**Checks** are machine-verified. The server polls them automatically — the operator sees a green tick when they pass, without having to do anything. Use them for things a machine can observe: "PR is merged", "review is approved".

**Confirms** are human-verified. They're checkboxes the operator ticks manually. Use them for operational observations only a person can make: "healthz returns 200", "CPU looks normal on the dashboard".

A `required` confirm (or input) gates step completion — the **Mark done** button stays disabled until it's filled in.

## Ordering steps with `requires`

Steps with `requires` show a **"blocked by N"** chip and can't be completed until their dependencies are done or skipped. This enforces ordering without hiding later steps from the operator.

```json
[
  { "id": "review", "title": "Merge the PR" },
  { "id": "deploy", "title": "Deploy", "requires": ["review"] },
  { "id": "smoke",  "title": "Smoke test", "requires": ["deploy"] }
]
```

## Branching paths

When a step has multiple possible routes — ship vs. roll back, for example — use `paths`. The operator selects a path, works through its specific instructions, and the result records which one was taken.

```json
{
  "id": "cutover",
  "title": "Cut over traffic",
  "paths": [
    {
      "id": "ship",
      "label": "Ship",
      "commands": ["./traffic-switch --to=green"],
      "confirms": [{ "id": "green_ok", "label": "Green looks healthy", "required": true }]
    },
    {
      "id": "rollback",
      "label": "Roll back",
      "outcome": "rolled back",
      "commands": ["./traffic-switch --to=blue"],
      "confirms": [{ "id": "blue_ok", "label": "Blue is stable", "required": true }]
    }
  ]
}
```

If the operator picks **Roll back** and completes the step, the result records `outcome: "rolled back"` and `selectedPath: "rollback"`.

## Auto-completing steps

Set `autoCompleteWhen: "checks_pass"` and the step marks itself done as soon as all its checks pass — the operator doesn't need to click anything. Useful for purely machine-verified gates.

```json
{
  "id": "wait_for_merge",
  "title": "Wait for the PR to merge",
  "checks": [{ "id": "merged", "label": "Merged", "kind": "github_pr_merged", "owner": "acme", "repo": "app", "number": 42 }],
  "autoCompleteWhen": "checks_pass"
}
```

## Collecting data

Use `inputs` to capture information the agent needs after the handback. All input values land in `result.steps[n].inputs`, keyed by `id`.

```json
"inputs": [
  { "id": "ticket", "label": "Incident ticket URL", "kind": "text" },
  { "id": "severity", "label": "Severity", "kind": "select", "options": ["P1", "P2", "P3"] },
  { "id": "affected", "label": "Affected services", "kind": "multiselect", "options": ["api", "web", "worker"] },
  { "id": "postmortem", "label": "Postmortem written", "kind": "checkbox" }
]
```

### Auto-populating inputs from a script

Rather than asking the operator to manually copy-paste command output, pair a `commands` entry with a `handback tee` invocation. The operator copies the command from the checklist, runs it, and the output lands in the textarea automatically:

```json
{
  "id": "deploy",
  "title": "Run the deploy",
  "commands": ["./deploy.sh | handback tee $SESSION_ID deploy output"],
  "inputs": [{ "id": "output", "label": "Deploy output", "kind": "textarea" }]
}
```

The agent can also pre-populate the field itself before the operator opens the step — useful when the agent already has the output:

```bash
# Start the session without blocking
SESSION=$(handback start release.json | jq -r .sessionId)

# Run a script and pipe its output into the step input
./deploy.sh | handback tee $SESSION deploy output

# Wait for the operator to finish
handback wait $SESSION
```

`tee` reads stdin, writes to stdout (so it chains), and POSTs the accumulated text to the named input.

## Agent notes

Use `note` for context the AI wants to pass to the human operator — gotchas, background, things to watch for. It renders as a collapsible "from the AI" callout so it's available without cluttering the view.

```json
{
  "id": "migrate",
  "title": "Run DB migration",
  "note": "This migration adds a NOT NULL column. It takes ~2 min on prod. If it fails, check the migration logs — the rollback is safe."
}
```

## A complete example

See [`examples/cross-service-release.json`](https://github.com/phin-tech/handback/blob/main/examples/cross-service-release.json) in the repo for a full, realistic multi-step release runbook.
