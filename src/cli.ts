#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createSession, buildResult, parseRawTask, resolveIncludes, applyVars, type Task } from "./core.js";
import { createSessionStore } from "./session-store.js";
import { openUrl } from "./server.js";

const args = process.argv.slice(2);
const command = args[0];
const store = createSessionStore();

try {
  if (command === "run") await run(args[1]);
  else if (command === "start") await start(args[1]);
  else if (command === "wait") await wait(args[1]);
  else if (command === "status") await status(args[1]);
  else if (command === "open") await open(args[1]);
  else if (command === "list") await list();
  else if (command === "tee") await tee(args[1], args[2], args[3]);
  else if (command === "doctor") doctor();
  else if (command === "--version" || command === "-v") version();
  else help(command ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function start(nameOrPath: string | undefined): Promise<void> {
  if (!nameOrPath) throw new Error("Usage: handback start <task.json|name> [--var key=value ...]");
  const session = await startSession(nameOrPath, parseVars(args.slice(2)));
  console.log(JSON.stringify({ sessionId: session.id, url: session.url, token: session.token }, null, 2));
}

async function run(nameOrPath: string | undefined): Promise<void> {
  if (!nameOrPath) throw new Error("Usage: handback run <task.json|name> [--var key=value ...]");
  const session = await startSession(nameOrPath, parseVars(args.slice(2)));
  console.error(JSON.stringify({ sessionId: session.id, url: session.url, token: session.token }, null, 2));
  await wait(session.id);
}

async function wait(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: handback wait <session-id>");
  for (;;) {
    const session = await store.load(id);
    if (session.status === "finished") {
      console.log(JSON.stringify(buildResult(session), null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function status(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: handback status <session-id>");
  const session = await store.load(id);
  const { token: _token, ...safe } = session;
  console.log(JSON.stringify(safe, null, 2));
}

async function open(id: string | undefined): Promise<void> {
  if (!id) throw new Error("Usage: handback open <session-id>");
  const session = await store.load(id);
  if (!session.url) throw new Error("Session has no URL yet");
  openUrl(session.url);
}

async function list(): Promise<void> {
  const sessions = await store.list();
  for (const session of sessions) {
    console.log(`${session.id}\t${session.status}\t${session.task.title}\t${session.url ?? ""}`);
  }
}

function doctor(): void {
  console.log(`Agent skill:
  npx skills add phin-tech/handback`);
}

async function waitForUrl(id: string) {
  for (let i = 0; i < 80; i += 1) {
    const session = await store.load(id);
    if (session.url) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start");
}

async function tee(id: string | undefined, stepId: string | undefined, inputId: string | undefined): Promise<void> {
  if (!id || !stepId || !inputId) throw new Error("Usage: handback tee <session-id> <step-id> <input-id> [--file <path>]");

  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx !== -1 ? args[fileIdx + 1] : undefined;
  if (fileIdx !== -1 && !filePath) throw new Error("--file requires a path argument");

  const session = await store.load(id);
  if (!session.port) throw new Error("Session server is not running");

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    process.stdout.write(chunk as Buffer);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const content = Buffer.concat(chunks);

  let inputValue: string;
  if (filePath) {
    await writeFile(filePath, content);
    inputValue = filePath;
  } else {
    inputValue = content.toString("utf8");
  }

  const res = await fetch(`http://127.0.0.1:${session.port}/api/steps/${encodeURIComponent(stepId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ inputs: { [inputId]: inputValue } })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(`Failed to update step: ${err.error ?? res.status}`);
  }
}

function help(code: number): never {
  console.error(`Usage:
  handback run <task.json|name> [--var key=value ...]
  handback start <task.json|name> [--var key=value ...]
  handback wait <session-id>
  handback status <session-id>
  handback open <session-id>
  handback list
  handback tee <session-id> <step-id> <input-id> [--file <path>]
  handback doctor

  Names resolve from $HANDBACK_PLANS/<name>.json or .handback/<name>.json in the git root.
  Template vars in task files use {{name}} syntax.`);
  process.exit(code);
}

function parseVars(argv: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--var" && i + 1 < argv.length) {
      const eq = argv[i + 1].indexOf("=");
      if (eq === -1) throw new Error(`--var requires key=value format, got: ${argv[i + 1]}`);
      vars[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
      i++;
    }
  }
  return vars;
}

function findGitRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Not in a git repository (and HANDBACK_PLANS is not set)");
  return result.stdout.trim();
}

async function resolvePlanPath(nameOrPath: string): Promise<string> {
  if (nameOrPath.includes("/") || nameOrPath.endsWith(".json")) return nameOrPath;
  const plansDir = process.env.HANDBACK_PLANS;
  if (plansDir) return join(plansDir, `${nameOrPath}.json`);
  return join(findGitRoot(), ".handback", `${nameOrPath}.json`);
}

async function loadTask(filePath: string, vars: Record<string, string>): Promise<Task> {
  let json = await readFile(filePath, "utf8");
  if (Object.keys(vars).length > 0) json = applyVars(json, vars);
  const raw = parseRawTask(JSON.parse(json));
  return resolveIncludes(raw, async (src, subVars) => loadTask(await resolvePlanPath(src), subVars));
}

async function startSession(nameOrPath: string, vars: Record<string, string>): Promise<{ id: string; url?: string; token: string }> {
  const task = await loadTask(await resolvePlanPath(nameOrPath), vars);
  const id = `hb_${randomBytes(5).toString("base64url")}`;
  const token = randomBytes(18).toString("base64url");
  await store.save(createSession({ id, token, task, now: new Date().toISOString() }));

  const child = spawn(process.execPath, [...process.execArgv, serverRunnerPath(), id], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env }
  });
  child.unref();

  return waitForUrl(id);
}

function version(): void {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

function serverRunnerPath(): string {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./server-runner.${ext}`, import.meta.url).pathname;
}
