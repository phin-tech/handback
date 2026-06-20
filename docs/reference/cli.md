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

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `HANDBACK_HOME` | `~/.handback` | Base directory for session storage. |
| `HANDBACK_OPEN` | `1` | Set to `0` to skip auto-opening the browser. |
