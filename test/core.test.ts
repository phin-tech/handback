import assert from "node:assert/strict";
import test from "node:test";
import {
  answerQuestion,
  appendQuestion,
  applyHumanStepUpdate,
  applyInputUpdate,
  applyVars,
  buildResult,
  canFinish,
  createSession,
  markAgentWaiting,
  nextQuestionEvent,
  parseRawTask,
  parseTask,
  resolveIncludes,
  updateStep,
  validateRawTask
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

test("askable defaults on but can be disabled", () => {
  const parsed = parseTask({
    title: "T",
    steps: [
      { id: "ask", title: "Ask" },
      { id: "quiet", title: "Quiet", askable: false }
    ]
  });

  assert.equal(parsed.steps[0].askable, true);
  assert.equal(parsed.steps[1].askable, false);

  const session = createSession({ id: "hb_q", token: "t", now: "t0", task: parsed });
  assert.throws(() => appendQuestion(session, { stepId: "quiet", id: "q1", text: "Can I ask?", now: "t1" }), /not askable/);
});

test("questions wake wait, can be answered, and are included in the result", () => {
  let session = createSession({ id: "hb_q", token: "t", now: "t0", task });

  session = appendQuestion(session, { stepId: "review-pr", id: "q1", text: "Which PR?", now: "t1" });
  assert.deepEqual(nextQuestionEvent(session), {
    type: "question",
    sessionId: "hb_q",
    stepId: "review-pr",
    question: { id: "q1", text: "Which PR?", askedAt: "t1" }
  });

  session = answerQuestion(session, { questionId: "q1", answer: "PR #2", now: "t2" });
  assert.equal(nextQuestionEvent(session), undefined);

  session = answerQuestion(session, { questionId: "q1", answer: "PR #3", now: "t3" });
  session = { ...session, status: "finished", outcome: "incomplete", finishedAt: "t4" };
  assert.deepEqual(buildResult(session).steps[0].questions, [
    { id: "q1", text: "Which PR?", askedAt: "t1", answer: "PR #3", answeredAt: "t2", updatedAt: "t3" }
  ]);
});

test("markAgentWaiting records a short expiry window", () => {
  const session = createSession({ id: "hb_wait", token: "t", now: "2026-06-22T14:00:00.000Z", task });
  const next = markAgentWaiting(session, { now: "2026-06-22T14:00:01.000Z", ttlMs: 2500 });

  assert.equal(next.agentWaitingUntil, "2026-06-22T14:00:03.500Z");
});

test("agent step updates merge through task validation and preserve state", () => {
  const session = createSession({ id: "hb_step", token: "t", now: "t0", task });
  const next = updateStep(session, {
    stepId: "review-pr",
    patch: { title: "Review updated PR", body: "Use the new diff." },
    now: "t1"
  });

  assert.equal(next.task.steps[0].title, "Review updated PR");
  assert.equal(next.task.steps[0].body, "Use the new diff.");
  assert.equal(next.steps["review-pr"].status, "pending");
  assert.throws(() => updateStep(session, { stepId: "review-pr", patch: { id: "renamed" }, now: "t2" }), /cannot change step id/);
  assert.throws(() => updateStep(session, { stepId: "review-pr", patch: { requires: ["missing"] }, now: "t2" }), /Unknown required step/);
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

test("applyInputUpdate auto-completes a pending step once every required field is set", () => {
  const requiredTask = parseTask({
    title: "T",
    steps: [
      {
        id: "s",
        title: "S",
        inputs: [
          { id: "summary", label: "Summary", kind: "text", required: true },
          { id: "notes", label: "Notes", kind: "textarea", required: true },
          { id: "approved", label: "Approved", kind: "checkbox", required: true },
          { id: "env", label: "Env", kind: "select", options: ["staging", "prod"], required: true },
          { id: "regions", label: "Regions", kind: "multiselect", options: ["us", "eu"], required: true },
          { id: "optional", label: "Optional", kind: "text" }
        ],
        confirms: [{ id: "confirmed", label: "Confirmed", required: true }],
        paths: [
          { id: "ship", label: "Ship" },
          { id: "rollback", label: "Rollback", confirms: [{ id: "rolled_back", label: "Rolled back", required: true }] }
        ]
      }
    ]
  });

  let session = createSession({ id: "hb", token: "t", now: "t0", task: requiredTask });

  session = applyInputUpdate(session, {
    stepId: "s",
    selectedPath: "rollback",
    inputs: {
      summary: "done",
      notes: "details",
      approved: true,
      env: "prod",
      regions: ["us"],
      confirmed: true
    },
    now: "t1"
  });

  assert.equal(session.steps.s.status, "pending");

  session = applyInputUpdate(session, {
    stepId: "s",
    inputs: { rolled_back: true },
    now: "t2"
  });

  assert.equal(session.steps.s.status, "done");
  assert.equal(session.steps.s.completedAt, "t2");
});

test("buildResult records selectedPath and the path's outcome", () => {
  let session = createSession({ id: "hb_adv", token: "t", now: "now", task: advancedTask });
  session = applyHumanStepUpdate(session, { stepId: "deploy", status: "done", inputs: { healthz: true, off: true }, selectedPath: "rollback", now: "t1" });
  session = { ...session, status: "finished", outcome: "completed", finishedAt: "t2" };
  const result = buildResult(session);
  assert.equal(result.steps[0].selectedPath, "rollback");
  assert.equal(result.steps[0].outcome, "rolled back");
});

test("applyVars substitutes {{key}} placeholders", () => {
  assert.equal(applyVars('{"pr": "{{pr}}"}', { pr: "42" }), '{"pr": "42"}');
  assert.throws(() => applyVars("{{missing}}", {}), /Missing template variable/);
});

test("parseRawTask accepts include markers alongside normal steps", () => {
  const raw = parseRawTask({
    title: "T",
    steps: [
      { id: "prep", title: "Prep" },
      { include: "smoke", as: "s", vars: { env: "staging" } }
    ]
  });
  assert.equal(raw.steps.length, 2);
  assert.ok("include" in raw.steps[1]);
});

test("resolveIncludes flattens sub-plan steps with namespace prefix", async () => {
  const raw = parseRawTask({
    title: "Release",
    steps: [
      { id: "prep", title: "Prep" },
      { include: "smoke", as: "smoke" },
      { id: "deploy", title: "Deploy", requires: ["smoke.verify"] }
    ]
  });

  const subPlan = parseTask({ title: "Smoke", steps: [{ id: "verify", title: "Verify" }] });
  const task = await resolveIncludes(raw, async () => subPlan);

  assert.deepEqual(
    task.steps.map((s) => s.id),
    ["prep", "smoke.verify", "deploy"]
  );
  assert.deepEqual(task.steps[2].requires, ["smoke.verify"]);
});

test("validateRawTask accepts a valid task and reports no unknown keys", () => {
  const report = validateRawTask({
    $schema: "https://example.com/task.schema.json",
    title: "T",
    steps: [{ id: "s", title: "S" }]
  });
  assert.equal(report.ok, true);
  if (report.ok) assert.deepEqual(report.unknownKeys, []);
});

test("validateRawTask flags unknown fields that runtime parsing would silently strip", () => {
  const report = validateRawTask({ title: "T", steps: [{ id: "s", title: "S", titel: "typo" }] });
  assert.equal(report.ok, true);
  if (report.ok) assert.deepEqual(report.unknownKeys, ["steps[0].titel"]);
});

test("validateRawTask reports missing required fields with a field path", () => {
  const report = validateRawTask({ steps: [] });
  assert.equal(report.ok, false);
  if (!report.ok) {
    const paths = report.issues.map((issue) => issue.path);
    assert.ok(paths.includes("title"));
    assert.ok(paths.includes("steps"));
  }
});

test("validateRawTask gives a branch-specific reason for a malformed step", () => {
  const report = validateRawTask({ title: "T", steps: [{ id: "a", requires: ["x"] }] });
  assert.equal(report.ok, false);
  if (!report.ok) {
    assert.ok(report.issues.some((issue) => issue.path === "steps[0].title"));
    assert.ok(report.issues.every((issue) => issue.message !== "Invalid input"));
  }
});

test("resolveIncludes rewrites internal requires but leaves cross-plan requires alone", async () => {
  const raw = parseRawTask({
    title: "Release",
    steps: [
      { id: "prep", title: "Prep" },
      { include: "smoke" }
    ]
  });

  const subPlan = parseTask({
    title: "Smoke",
    steps: [
      { id: "a", title: "A" },
      { id: "b", title: "B", requires: ["a"] }
    ]
  });
  const task = await resolveIncludes(raw, async () => subPlan);

  assert.equal(task.steps[2].id, "smoke.b");
  assert.deepEqual(task.steps[2].requires, ["smoke.a"]);
});
