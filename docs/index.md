---
layout: home

hero:
  name: handback
  tagline: Hand control from an agent to a human, then pick it back up.
  text: ''
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Task format reference
      link: /reference/task-format
    - theme: alt
      text: View on GitHub
      link: https://github.com/phin-tech/handback

features:
  - icon: 🧾
    title: Runbook-driven handoffs
    details: Define ordered steps with instructions, confirms, and shell commands. The agent passes a JSON task file; handback renders a one-column checklist your operator works through.

  - icon: 🔒
    title: Fully local
    details: The server binds to 127.0.0.1 only. Nothing leaves your machine — no external service, no account, no telemetry.

  - icon: ✅
    title: Auto-checks
    details: Steps can include machine-verified checks (e.g. "PR is merged") that resolve automatically via the GitHub CLI, so the operator only ticks what only a human can vouch for.

  - icon: 🔀
    title: Branching paths
    details: Steps support alternative paths — happy path vs. rollback, for example — and record which one was taken in the structured result the agent reads.

  - icon: 📦
    title: Structured output
    details: When the operator clicks Finish, handback prints a JSON result to stdout. The agent reads it and resumes — inputs, confirm values, step outcomes, all in one place.

  - icon: 🤖
    title: Agent skill included
    details: Ships with an installable agent skill that teaches Claude (or any agent) to write well-structured handback runbooks.
---
