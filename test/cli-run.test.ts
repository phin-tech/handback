import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("doctor prints the agent skill install command", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  const [code] = (await once(child, "exit")) as [number];

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /npx skills add phin-tech\/handback/);
});

test("package declares a postinstall doctor hint", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { files?: string[]; scripts?: Record<string, string> };

  assert.equal(pkg.scripts?.postinstall, "node scripts/postinstall.mjs");
  assert.ok(pkg.files?.includes("scripts/postinstall.mjs"));
});

test("package release script creates a GitHub release and does not publish locally", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  const release = pkg.scripts?.release ?? "";

  assert.match(release, /npm test/);
  assert.match(release, /npm run build/);
  assert.match(release, /git status --porcelain/);
  assert.match(release, /gh release create/);
  assert.doesNotMatch(release, /npm publish/);
  assert.doesNotMatch(release, /node -p \\\\"/);
  assert.match(release, /node -p 'require\("\.\/package\.json"\)\.version'/);
});

test("postinstall prints handback doctor hint", async () => {
  const child = spawn(process.execPath, ["scripts/postinstall.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  const [code] = (await once(child, "exit")) as [number];

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /handback doctor/);
});

test("help lists doctor", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  const [code] = (await once(child, "exit")) as [number];

  assert.equal(code, 0);
  assert.match(stderr, /handback doctor/);
});

async function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const [code] = (await once(child, "exit")) as [number];
  return { code, stdout, stderr };
}

test("validate exits 0 on a good task file", async () => {
  const { code, stdout } = await runCli(["validate", "examples/sample-task.json"]);
  assert.equal(code, 0);
  assert.match(stdout, /valid \(2 steps\)/);
});

test("validate exits non-zero and reports the failing field on a bad task file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-validate-test-"));
  try {
    const taskPath = join(dir, "bad.json");
    await writeFile(taskPath, JSON.stringify({ title: "T", steps: [{ id: "a", requires: ["x"] }] }));
    const { code, stderr } = await runCli(["validate", taskPath]);
    assert.equal(code, 1);
    assert.match(stderr, /steps\[0\]\.title/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate flags an unknown field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-validate-unknown-"));
  try {
    const taskPath = join(dir, "typo.json");
    await writeFile(taskPath, JSON.stringify({ title: "T", steps: [{ id: "s", title: "S", titel: "typo" }] }));
    const { code, stderr } = await runCli(["validate", taskPath]);
    assert.equal(code, 1);
    assert.match(stderr, /steps\[0\]\.titel: unknown field/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validate catches an unknown field inside an included task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-validate-include-"));
  try {
    await writeFile(join(dir, "root.json"), JSON.stringify({ title: "Root", steps: [{ id: "prep", title: "Prep" }, { include: "smoke" }] }));
    await writeFile(join(dir, "smoke.json"), JSON.stringify({ title: "Smoke", steps: [{ id: "verify", title: "Verify", titel: "typo" }] }));
    const { code, stderr } = await runCli(["validate", join(dir, "root.json")], { env: { HANDBACK_PLANS: dir } });
    assert.equal(code, 1);
    assert.match(stderr, /smoke: steps\[0\]\.titel: unknown field/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema prints the task JSON Schema to stdout", async () => {
  const { code, stdout } = await runCli(["schema"]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout) as { $id?: string; type?: string };
  assert.match(parsed.$id ?? "", /task\.schema\.json$/);
  assert.equal(parsed.type, "object");
});

test("doctor <file> validates the task instead of printing the skill hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-doctor-file-"));
  try {
    const taskPath = join(dir, "bad.json");
    await writeFile(taskPath, JSON.stringify({ steps: [] }));
    const { code, stderr, stdout } = await runCli(["doctor", taskPath]);
    assert.equal(code, 1);
    assert.match(stderr, /Validation failed/);
    assert.doesNotMatch(stdout, /npx skills add/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("tee --file writes content to disk and stores the path in the input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-tee-file-test-"));
  const taskPath = join(dir, "task.json");
  const logPath = join(dir, "output.log");
  const task = {
    title: "T",
    steps: [{ id: "deploy", title: "Deploy", inputs: [{ id: "log", label: "Log file", kind: "text" }] }]
  };
  await writeFile(taskPath, JSON.stringify(task));

  const starter = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "run", taskPath], {
    cwd: process.cwd(),
    env: { ...process.env, HANDBACK_HOME: dir, HANDBACK_OPEN: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let starterStderr = "";
    starter.stderr.on("data", (chunk) => (starterStderr += String(chunk)));
    const started = await waitFor(() => JSON.parse(starterStderr) as { sessionId: string; url: string; token: string });

    const teeProc = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "tee", started.sessionId, "deploy", "log", "--file", logPath],
      { cwd: process.cwd(), env: { ...process.env, HANDBACK_HOME: dir }, stdio: ["pipe", "pipe", "pipe"] }
    );
    teeProc.stdin.end("big log output");
    let teeStdout = "";
    teeProc.stdout.on("data", (chunk) => (teeStdout += String(chunk)));
    const [teeCode] = (await once(teeProc, "exit")) as [number];
    assert.equal(teeCode, 0);
    assert.equal(teeStdout, "big log output");

    // File should contain the content
    assert.equal((await readFile(logPath, "utf8")), "big log output");

    // Input should contain the file path, not the content
    const statusRes = await fetch(started.url.replace("/?", "/api/status?"));
    const body = await statusRes.json() as { session: { steps: Record<string, { inputs: Record<string, string> }> } };
    assert.equal(body.session.steps["deploy"]?.inputs["log"], logPath);
  } finally {
    if (starter.exitCode === null) starter.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("run resolves plan by name from HANDBACK_PLANS and substitutes --var", async () => {
  const dir = await mkdtemp(join(tmpdir(), "handback-plans-test-"));
  const plansDir = join(dir, "plans");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(plansDir);
  await writeFile(
    join(plansDir, "release.json"),
    JSON.stringify({ title: "Release {{version}}", steps: [{ id: "s", title: "Step" }] })
  );

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "run", "release", "--var", "version=1.3.0"],
    {
      cwd: process.cwd(),
      env: { ...process.env, HANDBACK_HOME: dir, HANDBACK_OPEN: "0", HANDBACK_PLANS: plansDir },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  try {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const started = await waitFor(() => JSON.parse(stderr) as { url: string });

    const statusRes = await fetch(started.url.replace("/?", "/api/status?"));
    const body = await statusRes.json() as { session: { task: { title: string } } };
    assert.equal(body.session.task.title, "Release 1.3.0");

    await fetch(started.url.replace("/?", "/api/finish?"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "incomplete" })
    });
  } finally {
    if (child.exitCode === null) child.kill();
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
