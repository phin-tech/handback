import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAutoComplete, applyHumanStepUpdate, applyInputUpdate, buildResult, finishSession, type Session, StepSchema, StepStatusSchema } from "./core.js";
import { runChecks } from "./checks.js";
import { createSessionStore } from "./session-store.js";

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
        if (req.method === "GET" && url.pathname === "/api/result") {
          if (session.status !== "finished") return empty(res, 204);
          return json(res, 200, buildResult(session));
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
  if (input.open) openUrl(url);
  return { port: address.port, url, close: closeServer, closed };
}

function publicSession(session: Session): Omit<Session, "token"> {
  const { token: _token, ...rest } = session;
  return rest;
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

export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
