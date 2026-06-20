import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSession, parseTask } from "../src/core.js";
import { createSessionStore } from "../src/session-store.js";

test("session store round-trips JSON in a real temp directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-test-"));
  try {
    const store = createSessionStore(dir);
    const session = createSession({
      id: "hb_store",
      token: "secret",
      now: "now",
      task: parseTask({ title: "T", steps: [{ id: "s", title: "Step" }] })
    });

    await store.save(session);

    assert.deepEqual(await store.load("hb_store"), session);
    assert.deepEqual((await store.list()).map((s) => s.id), ["hb_store"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
