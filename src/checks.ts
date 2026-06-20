import { spawn } from "node:child_process";
import type { CheckResult, Session } from "./core.js";

type RunResult = { code: number; stdout: string; stderr: string; missing?: boolean };
export type Runner = (command: string, args: string[]) => Promise<RunResult>;

export async function runChecks(session: Session, runner: Runner = runArgv): Promise<Record<string, CheckResult[]>> {
  const out: Record<string, CheckResult[]> = {};
  for (const step of session.task.steps) {
    out[step.id] = [];
    for (const check of step.checks ?? []) {
      const repo = `${check.owner}/${check.repo}`;
      if (check.kind === "github_pr_review_decision") {
        const result = await runner("gh", ["pr", "view", String(check.number), "--repo", repo, "--json", "reviewDecision", "-q", ".reviewDecision"]);
        out[step.id].push({
          id: check.id,
          status: result.missing ? "unavailable" : result.code === 0 && result.stdout.trim() === check.expect ? "pass" : "fail",
          output: result.missing ? "gh unavailable" : (result.stdout || result.stderr).trim()
        });
      } else if (check.kind === "github_pr_merged") {
        const result = await runner("gh", ["pr", "view", String(check.number), "--repo", repo, "--json", "state", "-q", ".state"]);
        out[step.id].push({
          id: check.id,
          status: result.missing ? "unavailable" : result.code === 0 && result.stdout.trim() === "MERGED" ? "pass" : "fail",
          output: result.missing ? "gh unavailable" : (result.stdout || result.stderr).trim()
        });
      }
    }
  }
  return out;
}

function runArgv(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", () => resolve({ code: 127, stdout, stderr, missing: true }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
