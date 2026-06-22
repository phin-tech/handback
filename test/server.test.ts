import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSession, parseTask } from "../src/core.js";
import { serveSession } from "../src/server.js";
import { createSessionStore } from "../src/session-store.js";

test("server closes itself after finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-server-test-"));
  try {
    const store = createSessionStore(dir);
    await store.save(
      createSession({
        id: "hb_server",
        token: "secret",
        now: "now",
        task: parseTask({ title: "T", steps: [{ id: "s", title: "Step" }] })
      })
    );

    const server = await serveSession({ id: "hb_server", sessionDir: dir, open: false });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/finish?token=secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "incomplete" })
    });

    assert.equal(res.status, 200);
    await server.closed;
    assert.equal((await store.load("hb_server")).status, "finished");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status-less POST autosaves inputs and path without changing status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-autosave-test-"));
  try {
    const store = createSessionStore(dir);
    await store.save(
      createSession({
        id: "hb_autosave",
        token: "secret",
        now: "now",
        task: parseTask({
          title: "T",
          steps: [
            {
              id: "s",
              title: "Step",
              inputs: [{ id: "notes", label: "Notes", kind: "text" }],
              paths: [
                { id: "a", label: "A" },
                { id: "b", label: "B" }
              ]
            }
          ]
        })
      })
    );

    const server = await serveSession({ id: "hb_autosave", sessionDir: dir, open: false });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/steps/s?token=secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: { notes: "wip" }, selectedPath: "b" })
      });
      assert.equal(res.status, 200);
      const loaded = await store.load("hb_autosave");
      assert.equal(loaded.steps.s.status, "pending");
      assert.equal(loaded.steps.s.inputs.notes, "wip");
      assert.equal(loaded.steps.s.selectedPath, "b");
    } finally {
      server.close();
      await server.closed;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent step append validates the body through StepSchema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-agentstep-test-"));
  try {
    const store = createSessionStore(dir);
    await store.save(
      createSession({ id: "hb_agent", token: "secret", now: "now", task: parseTask({ title: "T", steps: [{ id: "s", title: "Step" }] }) })
    );

    const server = await serveSession({ id: "hb_agent", sessionDir: dir, open: false });
    try {
      const bad = await fetch(`http://127.0.0.1:${server.port}/api/agent/steps?token=secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x" }) // missing required title
      });
      assert.equal(bad.status, 400);

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/agent/steps?token=secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x", title: "Added step" })
      });
      assert.equal(ok.status, 200);
      assert.equal((await store.load("hb_agent")).task.steps.length, 2);
    } finally {
      server.close();
      await server.closed;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("operator questions and agent answers persist through the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-question-server-test-"));
  try {
    const store = createSessionStore(dir);
    await store.save(
      createSession({ id: "hb_questions", token: "secret", now: "now", task: parseTask({ title: "T", steps: [{ id: "s", title: "Step" }] }) })
    );

    const server = await serveSession({ id: "hb_questions", sessionDir: dir, open: false });
    try {
      const asked = await fetch(`http://127.0.0.1:${server.port}/api/steps/s/questions?token=secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Which option?" })
      });
      assert.equal(asked.status, 200);
      const askedBody = await asked.json() as { question: { id: string } };

      const answered = await fetch(`http://127.0.0.1:${server.port}/api/agent/questions/${askedBody.question.id}/answer?token=secret`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "Use option A." })
      });
      assert.equal(answered.status, 200);

      const status = await fetch(`http://127.0.0.1:${server.port}/api/status?token=secret`);
      const body = await status.json() as { session: { steps: Record<string, { questions?: Array<{ text: string; answer?: string }> }> } };
      assert.deepEqual(body.session.steps.s.questions?.map((q) => [q.text, q.answer]), [["Which option?", "Use option A."]]);
    } finally {
      server.close();
      await server.closed;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent can update a live step through the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-step-update-server-test-"));
  try {
    const store = createSessionStore(dir);
    await store.save(
      createSession({ id: "hb_update_step", token: "secret", now: "now", task: parseTask({ title: "T", steps: [{ id: "s", title: "Old" }] }) })
    );

    const server = await serveSession({ id: "hb_update_step", sessionDir: dir, open: false });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent/steps/s?token=secret`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New", body: "Updated instructions." })
      });
      assert.equal(res.status, 200);
      assert.equal((await store.load("hb_update_step")).task.steps[0].title, "New");
    } finally {
      server.close();
      await server.closed;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
