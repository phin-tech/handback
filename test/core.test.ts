import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHumanStepUpdate,
  applyInputUpdate,
  buildResult,
  canFinish,
  createSession,
  parseTask
} from "../src/core.js";

const task = parseTask({
  title: "Release handback",
  steps: [
    {
      id: "review-pr",
      title: "Review PR",
      inputs: [
        { id: "notes", label: "Notes", kind: "textarea", required: true },
        { id: "approved", label: "Approved", kind: "checkbox" }
      ]
    },
    {
      id: "ship",
      title: "Ship",
      requires: ["review-pr"],
      inputs: [
        { id: "env", label: "Environment", kind: "select", options: ["staging", "prod"], required: true },
        { id: "regions", label: "Regions", kind: "multiselect", options: ["us-east-1", "us-west-2"] }
      ]
    }
  ]
});

test("createSession initializes pending step state", () => {
  const session = createSession({
    id: "hb_test",
    token: "secret",
    now: "2026-06-19T12:00:00.000Z",
    task
  });

  assert.equal(session.id, "hb_test");
  assert.equal(session.status, "active");
  assert.equal(session.steps["review-pr"].status, "pending");
  assert.equal(session.steps.ship.status, "pending");
});

test("required inputs gate completion", () => {
  const session = createSession({ id: "hb_test", token: "secret", now: "now", task });

  assert.throws(
    () => applyHumanStepUpdate(session, { stepId: "review-pr", status: "done", inputs: { notes: "" }, now: "later" }),
    /Missing required input/
  );

  const next = applyHumanStepUpdate(session, {
    stepId: "review-pr",
    status: "done",
    inputs: { notes: "LGTM", approved: true },
    now: "later"
  });

  assert.equal(next.steps["review-pr"].status, "done");
  assert.deepEqual(next.steps["review-pr"].inputs, { notes: "LGTM", approved: true });
});

test("finish requires done or skipped steps", () => {
  let session = createSession({ id: "hb_test", token: "secret", now: "now", task });

  assert.equal(canFinish(session), false);

  session = applyHumanStepUpdate(session, { stepId: "review-pr", status: "done", inputs: { notes: "ok" }, now: "t1" });
  session = applyHumanStepUpdate(session, { stepId: "ship", status: "skipped", inputs: {}, now: "t2" });

  assert.equal(canFinish(session), true);
});

test("result omits original task body and preserves compact state", () => {
  let session = createSession({ id: "hb_test", token: "secret", now: "now", task });
  session = applyHumanStepUpdate(session, { stepId: "review-pr", status: "done", inputs: { notes: "ok" }, now: "t1" });
  session = { ...session, status: "finished", outcome: "incomplete", finishedAt: "t2" };

  assert.deepEqual(buildResult(session), {
    sessionId: "hb_test",
    outcome: "incomplete",
    finishedAt: "t2",
    steps: [
      { id: "review-pr", status: "done", outcome: "done", inputs: { notes: "ok" }, selectedPath: undefined, completedAt: "t1", skippedAt: undefined, blockedAt: undefined },
      { id: "ship", status: "pending", outcome: "pending", inputs: {}, selectedPath: undefined, completedAt: undefined, skippedAt: undefined, blockedAt: undefined }
    ]
  });
});

const advancedTask = parseTask({
  title: "Cross-service",
  steps: [
    {
      id: "deploy",
      title: "Deploy",
      source: { kind: "repo", label: "phin-tech/orders-svc" },
      note: "additive migration; safe to run live",
      confirms: [{ id: "healthz", label: "healthz 200", required: true }],
      checks: [
        { id: "merged", label: "PR is merged", kind: "github_pr_merged", owner: "phin-tech", repo: "orders-svc", number: 88 },
        { id: "review", label: "approved", kind: "github_pr_review_decision", owner: "phin-tech", repo: "orders-svc", number: 88 }
      ],
      paths: [
        { id: "ship", label: "Ship it" },
        { id: "rollback", label: "Roll back", outcome: "rolled back", confirms: [{ id: "off", label: "flag off", required: true }] }
      ]
    }
  ]
});

test("parseTask accepts both check kinds and rejects an unknown one", () => {
  assert.equal(advancedTask.steps[0].checks?.length, 2);
  assert.throws(
    () => parseTask({ title: "T", steps: [{ id: "s", title: "S", checks: [{ id: "c", label: "c", kind: "bogus", owner: "o", repo: "r", number: 1 }] }] })
  );
});

test("parseTask rejects duplicate field ids within a step", () => {
  assert.throws(
    () =>
      parseTask({
        title: "T",
        steps: [{ id: "s", title: "S", inputs: [{ id: "x", label: "X", kind: "text" }], confirms: [{ id: "x", label: "X again" }] }]
      }),
    /Duplicate field id/
  );
});

test("required confirms gate completion (base + selected path only)", () => {
  const session = createSession({ id: "hb_adv", token: "t", now: "now", task: advancedTask });

  // base confirm missing → blocked
  assert.throws(
    () => applyHumanStepUpdate(session, { stepId: "deploy", status: "done", inputs: {}, now: "t" }),
    /Missing required confirmation/
  );

  // default path "ship" has no confirms, so base confirm alone is enough
  const shipped = applyHumanStepUpdate(session, { stepId: "deploy", status: "done", inputs: { healthz: true }, now: "t" });
  assert.equal(shipped.steps.deploy.status, "done");

  // selecting the rollback path adds its required confirm
  assert.throws(
    () => applyHumanStepUpdate(session, { stepId: "deploy", status: "done", inputs: { healthz: true }, selectedPath: "rollback", now: "t" }),
    /Missing required confirmation/
  );
  const rolled = applyHumanStepUpdate(session, { stepId: "deploy", status: "done", inputs: { healthz: true, off: true }, selectedPath: "rollback", now: "t" });
  assert.equal(rolled.steps.deploy.status, "done");
  assert.equal(rolled.steps.deploy.selectedPath, "rollback");
});

test("applyInputUpdate merges inputs and path without changing status", () => {
  const session = createSession({ id: "hb_adv", token: "t", now: "now", task: advancedTask });
  const next = applyInputUpdate(session, { stepId: "deploy", inputs: { healthz: true }, selectedPath: "rollback", now: "t" });
  assert.equal(next.steps.deploy.status, "pending");
  assert.equal(next.steps.deploy.inputs.healthz, true);
  assert.equal(next.steps.deploy.selectedPath, "rollback");
});

test("buildResult records selectedPath and the path's outcome", () => {
  let session = createSession({ id: "hb_adv", token: "t", now: "now", task: advancedTask });
  session = applyHumanStepUpdate(session, { stepId: "deploy", status: "done", inputs: { healthz: true, off: true }, selectedPath: "rollback", now: "t1" });
  session = { ...session, status: "finished", outcome: "completed", finishedAt: "t2" };
  const result = buildResult(session);
  assert.equal(result.steps[0].selectedPath, "rollback");
  assert.equal(result.steps[0].outcome, "rolled back");
});
