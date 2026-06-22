import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createSession, parseTask } from "../src/core.js";
import { serveSession } from "../src/server.js";
import { createSessionStore } from "../src/session-store.js";

test("browser completes a runbook and persists the result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-ui-test-"));
  const store = createSessionStore(dir);
  await store.save(
    createSession({
      id: "hb_ui",
      token: "secret",
      now: "now",
      task: parseTask({
        title: "Release handback",
        steps: [
          { id: "review", title: "Review PR", inputs: [{ id: "notes", label: "Notes", kind: "textarea", required: true }] },
          { id: "ship", title: "Ship", requires: ["review"], inputs: [{ id: "env", label: "Environment", kind: "select", options: ["staging", "prod"], required: true }] }
        ]
      })
    })
  );

  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let backend: Awaited<ReturnType<typeof serveSession>> | undefined;
  let backendClosed = false;

  try {
    backend = await serveSession({ id: "hb_ui", sessionDir: dir, open: false });
    vite = await createViteServer({
      configFile: false,
      root: "ui",
      plugins: [svelte()],
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": `http://127.0.0.1:${backend.port}` }
      }
    });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    assert.ok(url);

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${url}?token=secret`);

    await page.getByRole("heading", { name: "Release handback" }).first().waitFor();
    await assertEventually(async () => {
      assert.equal(await page.getByText("blocked by 1").count(), 1);
    });

    await page.getByLabel("Notes *").fill("LGTM");
    await step(page, "Review PR").locator("button.box").click();
    await assertEventually(async () => {
      assert.equal(await page.getByText("after 1").count(), 1);
    });

    await page.getByLabel("Environment *").selectOption("prod");
    await step(page, "Ship").locator("button.box").click();
    await page.getByRole("button", { name: "Finish" }).first().click();
    await page.getByText("Returned to agent. You can close this tab.").waitFor();
    await backend.closed;
    backendClosed = true;

    const saved = await store.load("hb_ui");
    assert.equal(saved.status, "finished");
    assert.equal(saved.outcome, "completed");
    assert.equal(saved.steps.review.inputs.notes, "LGTM");
    assert.equal(saved.steps.ship.inputs.env, "prod");
  } finally {
    await browser?.close();
    await vite?.close();
    if (backend && !backendClosed) {
      backend.close();
      await backend.closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser asks the agent and refreshes the answer inline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-ui-question-test-"));
  const store = createSessionStore(dir);
  await store.save(
    createSession({
      id: "hb_ui_question",
      token: "secret",
      now: "now",
      task: parseTask({ title: "Questions", steps: [{ id: "review", title: "Review PR" }] })
    })
  );

  let browser: Browser | undefined;
  let vite: ViteDevServer | undefined;
  let backend: Awaited<ReturnType<typeof serveSession>> | undefined;

  try {
    backend = await serveSession({ id: "hb_ui_question", sessionDir: dir, open: false });
    vite = await createViteServer({
      configFile: false,
      root: "ui",
      plugins: [svelte()],
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": `http://127.0.0.1:${backend.port}` }
      }
    });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    assert.ok(url);

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${url}?token=secret`);
    await page.getByRole("heading", { name: "Questions" }).first().waitFor();

    assert.equal(await page.getByPlaceholder("Ask the agent").count(), 0);
    const waiting = await fetch(`http://127.0.0.1:${backend.port}/api/agent/waiting?token=secret`, { method: "POST" });
    assert.equal(waiting.status, 200);
    await page.getByPlaceholder("Ask the agent").waitFor();

    await page.getByPlaceholder("Ask the agent").fill("Which option?");
    await page.getByRole("button", { name: "Ask" }).click();
    await page.getByText("Which option?").waitFor();

    const saved = await store.load("hb_ui_question");
    const questionId = saved.steps.review.questions?.[0]?.id;
    assert.ok(questionId);

    const res = await fetch(`http://127.0.0.1:${backend.port}/api/agent/questions/${questionId}/answer?token=secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "Use option A." })
    });
    assert.equal(res.status, 200);

    await page.getByText("Use option A.").waitFor();
  } finally {
    await browser?.close();
    await vite?.close();
    if (backend) {
      backend.close();
      await backend.closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

function step(page: Page, title: string): Locator {
  return page.locator("section.step").filter({ hasText: title });
}

async function assertEventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
