import { z } from "zod";

const inputBase = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().optional()
});

export const InputSchema = z.discriminatedUnion("kind", [
  inputBase.extend({ kind: z.literal("text") }),
  inputBase.extend({ kind: z.literal("textarea") }),
  inputBase.extend({ kind: z.literal("checkbox") }),
  inputBase.extend({ kind: z.literal("select"), options: z.array(z.string()).min(1) }),
  inputBase.extend({ kind: z.literal("multiselect"), options: z.array(z.string()).min(1) })
]);

const checkBase = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive()
});

export const CheckSchema = z.discriminatedUnion("kind", [
  checkBase.extend({
    kind: z.literal("github_pr_review_decision"),
    expect: z.enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"]).default("APPROVED")
  }),
  checkBase.extend({ kind: z.literal("github_pr_merged") })
]);

// Operator confirmation — a manual checkbox the human ticks. Distinct from data-collection
// inputs; its value persists in StepState.inputs keyed by id.
export const ConfirmSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().optional()
});

// Where a step happens. `repo` renders as a GitHub-style tag; `tool` for non-GitHub systems
// (LaunchDarkly, Slack, Linear, …).
export const SourceSchema = z.object({
  kind: z.enum(["repo", "tool"]),
  label: z.string().min(1),
  href: z.string().url().optional()
});

const LinkSchema = z.object({ label: z.string().min(1), href: z.string().url() });

// An alternative way to satisfy a step (e.g. a fallback / rollback). When a step is completed
// on a path whose `outcome` is set, the result records that label instead of plain "done".
export const PathSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  outcome: z.string().min(1).optional(),
  body: z.string().optional(),
  commands: z.array(z.string().min(1)).optional(),
  links: z.array(LinkSchema).optional(),
  confirms: z.array(ConfirmSchema).optional()
});

export const StepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  note: z.string().optional(),
  source: SourceSchema.optional(),
  links: z.array(LinkSchema).optional(),
  commands: z.array(z.string().min(1)).optional(),
  requires: z.array(z.string().min(1)).optional(),
  inputs: z.array(InputSchema).optional(),
  confirms: z.array(ConfirmSchema).optional(),
  checks: z.array(CheckSchema).optional(),
  paths: z.array(PathSchema).min(2).optional(),
  canCompleteWhen: z.enum(["always", "checks_pass"]).default("always"),
  autoCompleteWhen: z.enum(["never", "checks_pass"]).default("never")
});

export const TaskSchema = z.object({
  title: z.string().min(1),
  steps: z.array(StepSchema).min(1)
});

export const StepStatusSchema = z.enum(["pending", "done", "skipped", "blocked"]);
export const SessionOutcomeSchema = z.enum(["completed", "incomplete", "cancelled"]);

export type Task = z.infer<typeof TaskSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Path = z.infer<typeof PathSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;
export type InputValue = string | boolean | string[];

export type StepState = {
  status: StepStatus;
  inputs: Record<string, InputValue>;
  selectedPath?: string;
  completedAt?: string;
  skippedAt?: string;
  blockedAt?: string;
  updatedAt?: string;
};

export type Session = {
  id: string;
  token: string;
  status: "active" | "finished";
  outcome?: SessionOutcome;
  reason?: string;
  createdAt: string;
  finishedAt?: string;
  pid?: number;
  port?: number;
  url?: string;
  task: Task;
  steps: Record<string, StepState>;
};

export type CheckResult = {
  id: string;
  status: "pass" | "fail" | "unavailable";
  output?: string;
};

export function parseTask(input: unknown): Task {
  const task = TaskSchema.parse(input);
  const ids = new Set<string>();
  for (const step of task.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
    ids.add(step.id);
  }
  for (const step of task.steps) {
    for (const required of step.requires ?? []) {
      if (!ids.has(required)) throw new Error(`Unknown required step: ${required}`);
    }
    assertUniqueFieldIds(step);
  }
  return task;
}

// Inputs and confirms (base + every path's) share the StepState.inputs keyspace, so their ids
// must be unique within a step. Path ids must also be unique.
function assertUniqueFieldIds(step: Step): void {
  const fieldIds = new Set<string>();
  const claim = (id: string) => {
    if (fieldIds.has(id)) throw new Error(`Duplicate field id in step ${step.id}: ${id}`);
    fieldIds.add(id);
  };
  for (const input of step.inputs ?? []) claim(input.id);
  for (const confirm of step.confirms ?? []) claim(confirm.id);
  const pathIds = new Set<string>();
  for (const path of step.paths ?? []) {
    if (pathIds.has(path.id)) throw new Error(`Duplicate path id in step ${step.id}: ${path.id}`);
    pathIds.add(path.id);
    for (const confirm of path.confirms ?? []) claim(confirm.id);
  }
}

export function createSession(input: { id: string; token: string; now: string; task: Task }): Session {
  return {
    id: input.id,
    token: input.token,
    status: "active",
    createdAt: input.now,
    task: input.task,
    steps: Object.fromEntries(input.task.steps.map((step) => [step.id, { status: "pending", inputs: {} }]))
  };
}

export function applyHumanStepUpdate(
  session: Session,
  input: { stepId: string; status: StepStatus; inputs?: Record<string, InputValue>; selectedPath?: string; now: string }
): Session {
  const step = session.task.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) throw new Error(`Unknown step: ${input.stepId}`);
  const current = session.steps[input.stepId];
  if (!current) throw new Error(`Missing state for step: ${input.stepId}`);

  const nextInputs = { ...current.inputs, ...(input.inputs ?? {}) };
  const nextSelectedPath = input.selectedPath ?? current.selectedPath;
  if (input.status === "done") assertRequiredFields(step, nextInputs, nextSelectedPath);

  return {
    ...session,
    steps: {
      ...session.steps,
      [input.stepId]: {
        status: input.status,
        inputs: nextInputs,
        selectedPath: nextSelectedPath,
        updatedAt: input.now,
        completedAt: input.status === "done" ? input.now : current.completedAt,
        skippedAt: input.status === "skipped" ? input.now : current.skippedAt,
        blockedAt: input.status === "blocked" ? input.now : current.blockedAt
      }
    }
  };
}

// Persist input values / path selection without changing a step's status (autosave path).
export function applyInputUpdate(
  session: Session,
  input: { stepId: string; inputs?: Record<string, InputValue>; selectedPath?: string; now: string }
): Session {
  const step = session.task.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) throw new Error(`Unknown step: ${input.stepId}`);
  const current = session.steps[input.stepId];
  if (!current) throw new Error(`Missing state for step: ${input.stepId}`);

  return {
    ...session,
    steps: {
      ...session.steps,
      [input.stepId]: {
        ...current,
        inputs: { ...current.inputs, ...(input.inputs ?? {}) },
        selectedPath: input.selectedPath ?? current.selectedPath,
        updatedAt: input.now
      }
    }
  };
}

export function canFinish(session: Session): boolean {
  return Object.values(session.steps).every((step) => step.status === "done" || step.status === "skipped");
}

export function finishSession(
  session: Session,
  input: { outcome: SessionOutcome; reason?: string; now: string }
): Session {
  if (input.outcome === "completed" && !canFinish(session)) throw new Error("Finish requires all steps done or skipped");
  return { ...session, status: "finished", outcome: input.outcome, reason: input.reason, finishedAt: input.now };
}

export function applyAutoComplete(session: Session, results: Record<string, CheckResult[]> | undefined, now: string): Session {
  if (!results) return session;
  let next = session;
  for (const step of session.task.steps) {
    const state = next.steps[step.id];
    const stepResults = results[step.id] ?? [];
    if (state.status !== "pending" || step.autoCompleteWhen !== "checks_pass" || stepResults.length === 0) continue;
    if (stepResults.every((result) => result.status === "pass" || (result.status === "unavailable" && Boolean(state.inputs[result.id])))) {
      next = applyHumanStepUpdate(next, { stepId: step.id, status: "done", inputs: state.inputs, selectedPath: state.selectedPath, now });
    }
  }
  return next;
}

export function buildResult(session: Session) {
  const result = {
    sessionId: session.id,
    outcome: session.outcome,
    finishedAt: session.finishedAt,
    steps: session.task.steps.map((step) => {
      const state = session.steps[step.id];
      return {
        id: step.id,
        status: state.status,
        outcome: stepOutcome(step, state),
        inputs: state.inputs,
        selectedPath: state.selectedPath,
        completedAt: state.completedAt,
        skippedAt: state.skippedAt,
        blockedAt: state.blockedAt
      };
    })
  };
  return session.reason ? { ...result, reason: session.reason } : result;
}

// The effective path for a step: the explicitly selected one, else the first declared path.
function effectivePath(step: Step, selectedPath?: string): Path | undefined {
  if (!step.paths || step.paths.length === 0) return undefined;
  return step.paths.find((path) => path.id === selectedPath) ?? step.paths[0];
}

// What to report for a completed step: the chosen path's `outcome` label if set, else the
// status. Non-done steps just report their status.
function stepOutcome(step: Step, state: StepState): string {
  if (state.status !== "done") return state.status;
  return effectivePath(step, state.selectedPath)?.outcome ?? "done";
}

function assertRequiredFields(step: Step, inputs: Record<string, InputValue>, selectedPath?: string): void {
  const missing = (value: InputValue | undefined): boolean =>
    value === undefined || value === false || value === "" || (Array.isArray(value) && value.length === 0);

  for (const input of step.inputs ?? []) {
    if (input.required && missing(inputs[input.id])) throw new Error(`Missing required input: ${input.label}`);
  }

  const confirms = [...(step.confirms ?? [])];
  const activePath = effectivePath(step, selectedPath);
  if (activePath?.confirms) confirms.push(...activePath.confirms);
  for (const confirm of confirms) {
    if (confirm.required && missing(inputs[confirm.id])) throw new Error(`Missing required confirmation: ${confirm.label}`);
  }
}
