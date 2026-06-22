#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  answerQuestion,
  createSession,
  buildResult,
  markAgentWaiting,
  nextQuestionEvent,
  parseRawTask,
  resolveIncludes,
  applyVars,
  updateStep,
  validateRawTask,
  type Task
} from "./core.js";
import { createSessionStore } from "./session-store.js";
import { openUrl } from "./server.js";
import { buildTaskJsonSchema } from "./schema.js";

const args = process.argv.slice(2);
const command = args[0];
const store = createSessionStore();

try {
  if (command === "run") await run(args[1]);
  else if (command === "start") await start(args[1]);
  else if (command === "wait") await wait(args[1]);
  else if (command === "answer") await answer(args[1], args[2], args.slice(3).join(" "));
  else if (command === "update-step") await updateStepCommand(args[1], args[2]);
  else if (command === "status") await status(args[1]);
  else if (command === "open") await open(args[1]);
  else if (command === "list") await list();
  else if (command === "tee") await tee(args[1], args[2], args[3]);
  else if (command === "validate") await validate(args[1]);
  else if (command === "schema") schema();
  else if (command === "doctor") await doctor(args[1]);
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
    await markWaiting(session).catch(() => undefined);
    const question = nextQuestionEvent(session);
    if (question) {
      console.log(JSON.stringify(question, null, 2));
      return;
    }
    if (session.status === "finished") {
      console.log(JSON.stringify(buildResult(session), null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function markWaiting(session: { id: string; port?: number; token: string }): Promise<void> {
  if (session.port) {
    try {
      await postLive({ port: session.port, token: session.token }, "/api/agent/waiting", {});
      return;
    } catch {
      // Server may have gone away; keep wait usable for file-only sessions.
    }
  }
  const current = await store.load(session.id);
  await store.save(markAgentWaiting(current, { now: new Date().toISOString() }));
}

async function answer(id: string | undefined, questionId: string | undefined, text: string): Promise<void> {
  if (!id || !questionId || !text) throw new Error("Usage: handback answer <session-id> <question-id> <answer>");
  const session = await store.load(id);
  if (session.port) {
    await postLive({ port: session.port, token: session.token }, `/api/agent/questions/${encodeURIComponent(questionId)}/answer`, { answer: text });
    return;
  }
  await store.save(answerQuestion(session, { questionId, answer: text, now: new Date().toISOString() }));
}

async function updateStepCommand(id: string | undefined, stepId: string | undefined): Promise<void> {
  if (!id || !stepId) throw new Error("Usage: handback update-step <session-id> <step-id> --json '<partial step>'");
  const jsonIdx = args.indexOf("--json");
  const json = jsonIdx === -1 ? undefined : args[jsonIdx + 1];
  if (!json) throw new Error("--json requires a JSON object");
  const patch = JSON.parse(json);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("--json must be an object");
  const session = await store.load(id);
  if (session.port) {
    await patchLive({ port: session.port, token: session.token }, `/api/agent/steps/${encodeURIComponent(stepId)}`, patch);
    return;
  }
  await store.save(updateStep(session, { stepId, patch, now: new Date().toISOString() }));
}

async function postLive(session: { port: number; token: string }, path: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${session.port}${path}?token=${encodeURIComponent(session.token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await responseError(res));
}

async function patchLive(session: { port: number; token: string }, path: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${session.port}${path}?token=${encodeURIComponent(session.token)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await responseError(res));
}

async function responseError(res: Response): Promise<string> {
  const err = await res.json().catch(() => ({})) as { error?: string };
  return err.error ?? `request failed: ${res.status}`;
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

async function doctor(fileArg: string | undefined): Promise<void> {
  // `doctor <file>` validates the task; bare `doctor` prints setup hints.
  if (fileArg) {
    await validate(fileArg);
    return;
  }
  console.log(`Agent skill:
  npx skills add phin-tech/handback

Validate a task file:
  handback validate <task.json>`);
}

async function validate(nameOrPath: string | undefined): Promise<void> {
  if (!nameOrPath) throw new Error("Usage: handback validate <task.json|name> [--var key=value ...]");
  const vars = parseVars(args.slice(2));
  const filePath = await resolvePlanPath(nameOrPath);
  const schema = buildTaskJsonSchema();

  // Phase 1: structurally validate the root *and every included file*, reporting unknown/typo'd
  // fields per file. loadTask (phase 2) strips unknown keys silently, so without this a typo in
  // an included runbook would pass unnoticed.
  const errors: string[] = [];
  await collectFileErrors(filePath, vars, "", errors, schema, new Set());

  // Phase 2: cross-step checks (duplicate ids, unknown `requires`) and include resolution, only
  // once every file is structurally sound. loadTask reuses the exact pipeline `run` uses, so a
  // clean validate means a runnable file.
  if (errors.length === 0) {
    try {
      const task = await loadTask(filePath, vars);
      console.log(`✓ ${filePath} — valid (${task.steps.length} step${task.steps.length === 1 ? "" : "s"})`);
      return;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  fail(errors);
}

// Validate one task file (read → vars → parse → schema → unknown keys), then recurse into its
// `include` markers so the whole tree is checked. Errors are prefixed with `<source>: ` for any
// file other than the root so the operator can tell which runbook is at fault.
async function collectFileErrors(
  filePath: string,
  vars: Record<string, string>,
  label: string,
  errors: string[],
  schema: Record<string, unknown>,
  seen: Set<string>
): Promise<void> {
  if (seen.has(filePath)) return;
  seen.add(filePath);

  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    errors.push(`${label}cannot read file: ${filePath}`);
    return;
  }

  let json = source;
  if (Object.keys(vars).length > 0) {
    try {
      json = applyVars(json, vars);
    } catch (error) {
      errors.push(`${label}${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    errors.push(`${label}invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const report = validateRawTask(data);
  if (!report.ok) {
    for (const issue of report.issues) errors.push(`${label}${formatIssue(issue.path, issue.message, schema)}`);
    return;
  }
  for (const key of report.unknownKeys) {
    errors.push(`${label}${key}: unknown field — not part of the task schema (typo? wrong nesting?)`);
  }

  for (const entry of report.parsed.steps) {
    if ("include" in entry) {
      const subPath = await resolvePlanPath(entry.include);
      await collectFileErrors(subPath, entry.vars ?? {}, `${entry.include}: `, errors, schema, seen);
    }
  }
}

// Print the JSON Schema for a task file to stdout. The agent already has the CLI, so this is
// its zero-setup, version-matched way to fetch the full machine-readable field spec on demand —
// no path-finding into node_modules, no network.
function schema(): void {
  console.log(JSON.stringify(buildTaskJsonSchema(), null, 2));
}

// Print errors against a file and exit non-zero so validate is CI/agent-friendly.
function fail(messages: string[]): never {
  console.error("✗ Validation failed:");
  for (const message of messages) console.error(`  • ${message}`);
  process.exit(1);
}

function formatIssue(path: string, message: string, schema: Record<string, unknown>): string {
  const hint = describeAt(schema, path);
  return hint ? `${path}: ${message}\n      ↳ ${hint}` : `${path}: ${message}`;
}

// Best-effort lookup of a field's `description` in the JSON Schema for a dotted/indexed path,
// so a validation error can tell the agent what the field is for, not just where it failed.
function describeAt(schema: Record<string, unknown>, path: string): string | undefined {
  if (path === "(root)") return undefined;
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let node: Record<string, unknown> | undefined = schema;
  for (const segment of segments) {
    node = childSchema(node, segment);
    if (!node) return undefined;
  }
  return typeof node.description === "string" ? node.description : undefined;
}

function childSchema(node: Record<string, unknown> | undefined, segment: string): Record<string, unknown> | undefined {
  if (!node) return undefined;
  const branches = (node.anyOf as Record<string, unknown>[] | undefined) ?? (node.oneOf as Record<string, unknown>[] | undefined) ?? [node];
  const isIndex = /^\d+$/.test(segment);
  for (const branch of branches) {
    if (isIndex && branch.items) return branch.items as Record<string, unknown>;
    const properties = branch.properties as Record<string, Record<string, unknown>> | undefined;
    if (!isIndex && properties && segment in properties) return properties[segment];
  }
  return undefined;
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
  handback answer <session-id> <question-id> <answer>
  handback update-step <session-id> <step-id> --json '<partial step>'
  handback status <session-id>
  handback open <session-id>
  handback list
  handback tee <session-id> <step-id> <input-id> [--file <path>]
  handback validate <task.json|name> [--var key=value ...]
  handback schema
  handback doctor [task.json]

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
