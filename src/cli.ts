#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createSession, buildResult, parseTask } from "./core.js";
import { createSessionStore } from "./session-store.js";

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
  else help(command ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function start(path: string | undefined): Promise<void> {
  if (!path) throw new Error("Usage: handback start <task.json>");
  const session = await startSession(path);
  console.log(JSON.stringify({ sessionId: session.id, url: session.url, token: session.token }, null, 2));
}

async function run(path: string | undefined): Promise<void> {
  if (!path) throw new Error("Usage: handback run <task.json>");
  const session = await startSession(path);
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
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const openArgs = process.platform === "win32" ? ["/c", "start", "", session.url] : [session.url];
  spawn(opener, openArgs, { detached: true, stdio: "ignore" }).unref();
}

async function list(): Promise<void> {
  const sessions = await store.list();
  for (const session of sessions) {
    console.log(`${session.id}\t${session.status}\t${session.task.title}\t${session.url ?? ""}`);
  }
}

async function waitForUrl(id: string) {
  for (let i = 0; i < 80; i += 1) {
    const session = await store.load(id);
    if (session.url) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start");
}

function help(code: number): never {
  console.error(`Usage:
  handback run <task.json>
  handback start <task.json>
  handback wait <session-id>
  handback status <session-id>
  handback open <session-id>
  handback list`);
  process.exit(code);
}

async function startSession(path: string): Promise<{ id: string; url?: string; token: string }> {
  const task = parseTask(JSON.parse(await readFile(path, "utf8")));
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

function serverRunnerPath(): string {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`./server-runner.${ext}`, import.meta.url).pathname;
}
