import assert from "node:assert/strict";
import test from "node:test";
import { createSession, parseTask } from "../src/core.js";
import { runChecks, type Runner } from "../src/checks.js";

function sessionWith(kind: "github_pr_review_decision" | "github_pr_merged") {
  const task = parseTask({
    title: "T",
    steps: [{ id: "s", title: "S", checks: [{ id: "c", label: "check", kind, owner: "o", repo: "r", number: 1 }] }]
  });
  return createSession({ id: "hb", token: "t", now: "now", task });
}

const runner =
  (out: { code?: number; stdout?: string; stderr?: string; missing?: boolean }): Runner =>
  async () => ({ code: out.code ?? 0, stdout: out.stdout ?? "", stderr: out.stderr ?? "", missing: out.missing });

test("github_pr_merged passes when state is MERGED", async () => {
  const results = await runChecks(sessionWith("github_pr_merged"), runner({ stdout: "MERGED\n" }));
  assert.equal(results.s[0].status, "pass");
});

test("github_pr_merged fails when not merged", async () => {
  const results = await runChecks(sessionWith("github_pr_merged"), runner({ stdout: "OPEN\n" }));
  assert.equal(results.s[0].status, "fail");
});

test("github_pr_merged is unavailable when gh is missing", async () => {
  const results = await runChecks(sessionWith("github_pr_merged"), runner({ code: 127, missing: true }));
  assert.equal(results.s[0].status, "unavailable");
  assert.equal(results.s[0].output, "gh unavailable");
});

test("github_pr_review_decision passes when APPROVED", async () => {
  const results = await runChecks(sessionWith("github_pr_review_decision"), runner({ stdout: "APPROVED\n" }));
  assert.equal(results.s[0].status, "pass");
});
