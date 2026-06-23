import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerQuestion,
  appendQuestion,
  applyAutoComplete,
  applyHumanStepUpdate,
  applyInputUpdate,
  buildResult,
  finishSession,
  markAgentWaiting,
  type Session,
  StepSchema,
  StepStatusSchema,
  updateStep
} from "./core.js";
import { runChecks } from "./checks.js";
import { createSessionStore } from "./session-store.js";
import { loadConfig, resolveFloating, resolveOpenLinksApp, resolveUseGlimpse, saveConfig, type HandbackConfig } from "./config.js";

export async function serveSession(input: { id: string; sessionDir?: string; open?: boolean }): Promise<{ port: number; url: string; close: () => void; closed: Promise<void> }> {
  const store = createSessionStore(input.sessionDir);
  let session = await store.load(input.id);
  let lastChecks: Awaited<ReturnType<typeof runChecks>> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (url.pathname.startsWith("/api/")) {
        if (url.searchParams.get("token") !== session.token && req.headers.authorization !== `Bearer ${session.token}`) {
          return json(res, 401, { error: "unauthorized" });
        }
        if (req.method === "GET" && url.pathname === "/api/status") {
          lastChecks = await runChecks(session);
          session = applyAutoComplete(session, lastChecks, new Date().toISOString());
          await store.save(session);
          return json(res, 200, { session: publicSession(session), checks: lastChecks });
        }
        if (url.pathname === "/api/config") {
          if (req.method === "GET") return json(res, 200, effectiveConfig());
          if (req.method === "PATCH") {
            const body = await readJson(req);
            const patch: Partial<HandbackConfig> = {};
            if (typeof body.glimpse === "boolean") patch.glimpse = body.glimpse;
            if (typeof body.floating === "boolean") patch.floating = body.floating;
            if (typeof body.openLinksApp === "string") {
              const trimmed = body.openLinksApp.trim();
              patch.openLinksApp = trimmed || undefined;
            }
            saveConfig(patch);
            return json(res, 200, effectiveConfig());
          }
        }
        if (req.method === "GET" && url.pathname === "/api/result") {
          if (session.status !== "finished") return empty(res, 204);
          return json(res, 200, buildResult(session));
        }
        if (req.method === "POST" && url.pathname === "/api/agent/waiting") {
          session = markAgentWaiting(session, { now: new Date().toISOString() });
          await store.save(session);
          return json(res, 200, publicSession(session));
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/steps/") && url.pathname.endsWith("/questions")) {
          const stepId = decodeURIComponent(url.pathname.slice("/api/steps/".length, -"/questions".length));
          const body = await readJson(req);
          const now = new Date().toISOString();
          session = appendQuestion(session, { stepId, id: `q_${randomBytes(5).toString("base64url")}`, text: String(body.text ?? ""), now });
          await store.save(session);
          const question = session.steps[stepId]?.questions?.at(-1);
          return json(res, 200, { session: publicSession(session), question });
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/steps/")) {
          const stepId = decodeURIComponent(url.pathname.slice("/api/steps/".length));
          const body = await readJson(req);
          const now = new Date().toISOString();
          if (body.status === undefined || body.status === null) {
            // Autosave: persist inputs / path selection without changing status.
            session = applyInputUpdate(session, { stepId, inputs: body.inputs ?? {}, selectedPath: body.selectedPath, now });
          } else {
            const status = StepStatusSchema.parse(body.status);
            session = applyHumanStepUpdate(session, { stepId, status, inputs: body.inputs ?? {}, selectedPath: body.selectedPath, now });
          }
          await store.save(session);
          return json(res, 200, publicSession(session));
        }
        if (req.method === "POST" && url.pathname === "/api/finish") {
          const body = await readJson(req);
          session = finishSession(session, { outcome: body.outcome, reason: body.reason, now: new Date().toISOString() });
          await store.save(session);
          res.on("finish", () => closeServer());
          json(res, 200, buildResult(session));
          return;
        }
        if (req.method === "PATCH" && url.pathname.startsWith("/api/steps/")) {
          const stepId = decodeURIComponent(url.pathname.slice("/api/steps/".length));
          const body = await readJson(req);
          const commands = body.commands;
          if (!Array.isArray(commands) || commands.some((c: unknown) => typeof c !== "string" || !c.trim())) {
            return json(res, 400, { error: "commands must be a non-empty array of strings" });
          }
          const idx = session.task.steps.findIndex((s) => s.id === stepId);
          if (idx === -1) return json(res, 404, { error: "step not found" });
          const steps = session.task.steps.map((s) => (s.id === stepId ? { ...s, commands: commands as string[] } : s));
          session = { ...session, task: { ...session.task, steps } };
          await store.save(session);
          return json(res, 200, publicSession(session));
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/agent/questions/") && url.pathname.endsWith("/answer")) {
          const questionId = decodeURIComponent(url.pathname.slice("/api/agent/questions/".length, -"/answer".length));
          const body = await readJson(req);
          session = answerQuestion(session, { questionId, answer: String(body.answer ?? ""), now: new Date().toISOString() });
          await store.save(session);
          return json(res, 200, publicSession(session));
        }
        if (req.method === "PATCH" && url.pathname.startsWith("/api/agent/steps/")) {
          const stepId = decodeURIComponent(url.pathname.slice("/api/agent/steps/".length));
          const body = await readJson(req);
          session = updateStep(session, { stepId, patch: body, now: new Date().toISOString() });
          await store.save(session);
          return json(res, 200, publicSession(session));
        }
        if (req.method === "POST" && url.pathname === "/api/agent/steps") {
          const body = await readJson(req);
          const parsed = StepSchema.safeParse(body);
          if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid step" });
          const step = parsed.data;
          if (session.steps[step.id]) return json(res, 400, { error: "invalid step id" });
          session = {
            ...session,
            task: { ...session.task, steps: [...session.task.steps, step] },
            steps: { ...session.steps, [step.id]: { status: "pending", inputs: {} } }
          };
          await store.save(session);
          return json(res, 200, publicSession(session));
        }
        return json(res, 404, { error: "not found" });
      }
      return staticFile(res, url.pathname);
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on("close", resolveClosed);

  function closeServer(): void {
    server.close();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind server");
  const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(session.token)}`;
  session = { ...session, pid: process.pid, port: address.port, url };
  await store.save(session);
  if (input.open) await openSession(url, { onClose: handleWindowClosed });
  return { port: address.port, url, close: closeServer, closed };

  // The operator closed the native window without finishing — end the session as
  // cancelled so a blocked `handback run`/`wait` returns instead of hanging.
  async function handleWindowClosed(): Promise<void> {
    if (session.status === "finished") return;
    session = finishSession(session, { outcome: "cancelled", reason: "window closed", now: new Date().toISOString() });
    await store.save(session);
    closeServer();
  }
}

function publicSession(session: Session): Omit<Session, "token"> {
  const { token: _token, ...rest } = session;
  return rest;
}

// Settings the runbook UI can read/write, with env vars and defaults already applied.
// `apps` are link-handler candidates discovered on this machine for the dropdown.
function effectiveConfig(): { glimpse: boolean; floating: boolean; openLinksApp: string; apps: AppChoice[] } {
  const config = loadConfig();
  return {
    glimpse: resolveUseGlimpse(config),
    floating: resolveFloating(config),
    openLinksApp: resolveOpenLinksApp(config) ?? "",
    apps: discoverApps()
  };
}

interface AppChoice {
  label: string;
  value: string;
}

// Apps that can sensibly receive an http/https link (browsers + Linear, which
// parses its own linear.app URLs). `--open-links-app` wants a full path to the
// bundle, so we return paths and let the UI offer a free-text override too.
const KNOWN_LINK_APPS = [
  "Safari",
  "Google Chrome",
  "Arc",
  "Firefox",
  "Brave Browser",
  "Microsoft Edge",
  "Vivaldi",
  "Opera",
  "Zen",
  "Orion",
  "Linear"
];

// Best-effort discovery of installed link handlers. macOS scans the Applications
// folders; other platforms return nothing and rely on the override field, since
// app locations there aren't reliably enumerable.
function discoverApps(): AppChoice[] {
  if (process.platform !== "darwin") return [];
  const dirs = ["/Applications", join(homedir(), "Applications")];
  const found: AppChoice[] = [];
  for (const label of KNOWN_LINK_APPS) {
    for (const dir of dirs) {
      const path = join(dir, `${label}.app`);
      if (existsSync(path)) {
        found.push({ label, value: path });
        break;
      }
    }
  }
  return found;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += String(chunk)));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function empty(res: ServerResponse, code: number): void {
  res.writeHead(code);
  res.end();
}

async function staticFile(res: ServerResponse, pathname: string): Promise<void> {
  const root = fileURLToPath(new URL("../ui/", import.meta.url));
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if (requested.includes("..")) return json(res, 400, { error: "bad path" });
  const file = join(root, requested);
  const fallback = join(root, "index.html");
  const target = existsSync(file) ? file : fallback;
  res.writeHead(200, { "content-type": contentType(target) });
  createReadStream(target).pipe(res);
}

function contentType(file: string): string {
  return extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html";
}

// Open a runbook for the operator: prefer a Glimpse native webview window when
// `glimpseui` is installed, falling back to the system browser otherwise. Mirrors
// how plannotator opens its UI (https://github.com/hazat/glimpse).
//
// `onClose` fires when the operator closes a Glimpse window (browser tabs can't be
// observed), so the caller can end an abandoned session instead of blocking forever.
export async function openSession(url: string, options?: { onClose?: () => void }): Promise<void> {
  if (await openGlimpse(url, options?.onClose)) return;
  openUrl(url);
}

export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// A minimal page that redirects the native window to the live session URL.
// Glimpse takes HTML on stdin, so we hand it a stub that navigates to the server.
function glimpseRedirectHtml(url: string): string {
  const target = JSON.stringify(url);
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>handback</title>",
    "<style>html,body{width:100%;height:100%;margin:0}body{overflow:hidden;background:#0f1115}</style>",
    `</head><body><script>location.replace(${target})</script></body></html>`
  ].join("");
}

// Absolute path to the `glimpseui` binary if it's on PATH, else undefined.
// Exposed for `handback doctor` to report install status.
export function findGlimpse(): string | undefined {
  return whichSync("glimpseui");
}

// Resolve an executable name to an absolute path by scanning $PATH (with $PATHEXT
// on Windows), like `which`. Returns undefined when it isn't installed.
function whichSync(cmd: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// Spawn `glimpseui` and pipe it the redirect stub. Resolves true once the window
// is up (no error/exit within a short grace window), false to fall back to a browser.
// Once open, `onClose` fires when the window is closed (the glimpseui process exits).
async function openGlimpse(url: string, onClose?: () => void): Promise<boolean> {
  if (!resolveUseGlimpse()) return false;
  const cli = findGlimpse();
  if (!cli) return false;

  const config = loadConfig();
  const openLinksApp = resolveOpenLinksApp(config);
  const args = [
    "--width", String(Number(process.env.HANDBACK_GLIMPSE_WIDTH) || 1100),
    "--height", String(Number(process.env.HANDBACK_GLIMPSE_HEIGHT) || 900),
    "--title", "handback",
    // Open external links in a chosen browser app, else the system default.
    ...(openLinksApp ? ["--open-links-app", openLinksApp] : ["--open-links"]),
    ...(resolveFloating(config) ? ["--floating"] : [])
  ];

  // On Windows `glimpseui` resolves to an npm script shim, not an .exe, which
  // spawn() can't launch without a shell — and `shell: true` would break the
  // stdin HTML pipe. Run the package entry with node directly instead.
  let command = cli;
  let spawnArgs = args;
  if (process.platform === "win32" && !/\.exe$/i.test(cli)) {
    const node = whichSync("node");
    const entry = join(cli, "..", "node_modules", "glimpseui", "bin", "glimpse.mjs");
    if (node && existsSync(entry)) {
      command = node;
      spawnArgs = [entry, ...args];
    }
  }

  const html = glimpseRedirectHtml(url);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let opened = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      opened = ok;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(command, spawnArgs, { detached: true, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.unref();
      finish(true);
    }, 750);
    child.once("error", () => finish(false));
    // An exit before the grace window means the launch failed; after it means the
    // operator closed the window, so notify the caller.
    child.once("exit", () => {
      if (!settled) finish(false);
      else if (opened) onClose?.();
    });
    child.stdin.once("error", () => finish(false));
    child.stdin.end(html);
  });
}
