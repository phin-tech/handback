import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("run blocks until finish and then prints result JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-run-test-"));
  const taskPath = join(dir, "task.json");
  await writeFile(taskPath, JSON.stringify({ title: "T", steps: [{ id: "s", title: "Step" }] }));

  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "run", taskPath], {
    cwd: process.cwd(),
    env: { ...process.env, HANDBACK_HOME: dir, HANDBACK_OPEN: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));

    const started = await waitFor(() => JSON.parse(stderr) as { url: string; token: string });
    assert.equal(child.exitCode, null);

    const res = await fetch(started.url.replace("/?", "/api/finish?"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "incomplete", reason: "test" })
    });
    assert.equal(res.status, 200);

    const [code] = (await once(child, "exit")) as [number];
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).outcome, "incomplete");
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tee pipes stdin to stdout and writes it into the named step input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-tee-test-"));
  const taskPath = join(dir, "task.json");
  const task = {
    title: "T",
    steps: [{ id: "deploy", title: "Deploy", inputs: [{ id: "output", label: "Output", kind: "textarea" }] }]
  };
  await writeFile(taskPath, JSON.stringify(task));

  // Start a session and grab its id + url + token from stderr
  const starter = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "run", taskPath], {
    cwd: process.cwd(),
    env: { ...process.env, HANDBACK_HOME: dir, HANDBACK_OPEN: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let starterStderr = "";
    starter.stderr.on("data", (chunk) => (starterStderr += String(chunk)));
    const started = await waitFor(() => JSON.parse(starterStderr) as { sessionId: string; url: string; token: string });

    // Run tee, piping a known string into stdin
    const teeProc = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "tee", started.sessionId, "deploy", "output"], {
      cwd: process.cwd(),
      env: { ...process.env, HANDBACK_HOME: dir },
      stdio: ["pipe", "pipe", "pipe"]
    });
    teeProc.stdin.end("hello from tee");
    let teeStdout = "";
    teeProc.stdout.on("data", (chunk) => (teeStdout += String(chunk)));
    const [teeCode] = (await once(teeProc, "exit")) as [number];
    assert.equal(teeCode, 0);
    assert.equal(teeStdout, "hello from tee");

    // Verify the input was written to the session
    const statusRes = await fetch(started.url.replace("/?", "/api/status?"));
    const body = await statusRes.json() as { session: { steps: Record<string, { inputs: Record<string, string> }> } };
    assert.equal(body.session.steps["deploy"]?.inputs["output"], "hello from tee");
  } finally {
    if (starter.exitCode === null) starter.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitFor<T>(fn: () => T): Promise<T> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}
