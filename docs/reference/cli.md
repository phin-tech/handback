# CLI reference

```
handback <command> [options]
```

## Commands

### `handback run <task.json>`

Start a session, open the browser, block until the operator clicks Finish, then print the result JSON to stdout.

```bash
handback run release.json
```

This is the most common command. The agent calls it and awaits the result.

### `handback start <task.json>`

Start a session without blocking. Prints `{ sessionId, url, token }` immediately and returns.

```bash
handback start release.json
# → { "sessionId": "hb_…", "url": "http://127.0.0.1:3742/session/hb_…?token=…", "token": "…" }
```

Use this when you want to hand off the URL through a separate channel, or combine with `handback wait`.

### `handback wait <session-id>`

Block until a started session finishes, then print the result JSON.

```bash
handback wait hb_abc123
```

### `handback status <session-id>`

Print a session's current state. The auth token is redacted.

```bash
handback status hb_abc123
```

### `handback open <session-id>`

Open a session's URL in the default browser.

```bash
handback open hb_abc123
```

### `handback list`

List all sessions.

```bash
handback list
```

### `handback tee <session-id> <step-id> <input-id> [--file <path>]`

Pipe a script's output into a specific input field on a step. Reads from stdin, writes to stdout (so it chains with other pipes), then POSTs to the named input.

```bash
# Store the output directly in the input field (good for short output)
./deploy.sh | handback tee hb_abc123 deploy output

# Write the output to a file and store the file path in the input field (good for large logs)
./deploy.sh | handback tee hb_abc123 deploy log --file /tmp/deploy.log
```

Without `--file`, the full content is stored in the input field and returned in the result JSON. With `--file`, the content is written to that path and the path itself is stored in the input — keeping large logs out of the session JSON while still giving the agent something to read back.

### `handback validate <task.json>`

Validate a task file without running it. Reports unknown/mistyped fields, missing or malformed fields (with the field's purpose), duplicate step ids, and bad `requires` references. Exits non-zero on failure, so it slots into CI or an agent's author → validate → run loop.

```bash
handback validate release.json
# ✓ release.json — valid (5 steps)

handback validate broken.json
# ✗ Validation failed:
#   • steps[0].title: Invalid input: expected string, received undefined
#       ↳ Step heading shown to the operator.
```

Accepts a plan name and `--var` exactly like `run`, and resolves `include` markers, so a clean validate means a runnable file. A machine-readable [JSON Schema](https://raw.githubusercontent.com/phin-tech/handback/main/schema/task.schema.json) ships in the package (`schema/task.schema.json`); point a task file's `$schema` at it for editor autocomplete and inline validation.

### `handback schema`

Print the task-file JSON Schema to stdout. This is how an agent (or any tool) gets the full, version-matched field spec without hunting for the file in `node_modules` or fetching it over the network — it already has the CLI.

```bash
handback schema > task.schema.json   # vendor it locally
handback schema | jq '.properties.steps'
```

### `handback doctor [task.json]`

With no argument, prints setup hints (agent-skill install command). With a file argument, validates it — equivalent to `handback validate <task.json>`.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `HANDBACK_HOME` | `~/.handback` | Base directory for session storage. |
| `HANDBACK_OPEN` | `1` | Set to `0` to skip auto-opening the browser. |
| `HANDBACK_GLIMPSE` | `1` | When [`glimpseui`](https://github.com/hazat/glimpse) is on `PATH`, runbooks open in a native window instead of the browser. Set to `0` to always use the browser. |
| `HANDBACK_GLIMPSE_WIDTH` | `1100` | Width in pixels of the Glimpse native window. |
| `HANDBACK_GLIMPSE_HEIGHT` | `900` | Height in pixels of the Glimpse native window. |
| `HANDBACK_GLIMPSE_FLOATING` | `0` | Set to `1` to keep the Glimpse window floating above other windows. |
| `HANDBACK_GLIMPSE_OPEN_LINKS_APP` | — | Full path to an app (e.g. `/Applications/Linear.app`) that opens http/https links from the Glimpse window. Defaults to the system browser. |
| `HANDBACK_CONFIG` | `$XDG_CONFIG_HOME/handback/settings.json` | Path to the settings file. |

## Settings file

Persistent settings live at `~/.config/handback/settings.json` (honoring
`$XDG_CONFIG_HOME`; override the whole path with `HANDBACK_CONFIG`):

```json
{
  "glimpse": true,
  "floating": false,
  "openLinksApp": "/Applications/Linear.app"
}
```

| Key | Default | Notes |
| --- | --- | --- |
| `glimpse` | `true` | Open runbooks in a [Glimpse](https://github.com/hazat/glimpse) native window when `glimpseui` is installed. `HANDBACK_GLIMPSE` overrides this. |
| `floating` | `false` | Keep the Glimpse window floating above other windows. `HANDBACK_GLIMPSE_FLOATING` overrides this. |
| `openLinksApp` | — | Full path to an app that opens http/https links. Point it at `/Applications/Linear.app` to open `linear.app` links in the desktop app. `HANDBACK_GLIMPSE_OPEN_LINKS_APP` overrides this. |

Glimpse is detected on `PATH` and used only if installed — install it with
`npm install -g glimpseui`. When it isn't present, handback opens the system
browser as before. The `floating` and `openLinksApp` settings can also be
changed from the runbook's **Settings** panel (⚙ in the top bar); they apply
to the next runbook window. The "Open links in" dropdown lists browsers and
apps detected on your machine (macOS), with a **Custom…** option for any other
path.
