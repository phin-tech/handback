import { z } from "zod";

const inputBase = z.object({
  id: z.string().min(1).describe("Unique within the step; the value the human enters is keyed by this id in the result."),
  label: z.string().min(1).describe("Field label shown to the operator."),
  required: z.boolean().optional().describe("When true, the step can't be completed until this field has a value.")
});

export const InputSchema = z.discriminatedUnion("kind", [
  inputBase.extend({ kind: z.literal("text").describe("Single-line text input → string value.") }),
  inputBase.extend({ kind: z.literal("textarea").describe("Multi-line text input → string value.") }),
  inputBase.extend({ kind: z.literal("checkbox").describe("Single checkbox → boolean value.") }),
  inputBase.extend({
    kind: z.literal("select").describe("Pick one of `options` → string value."),
    options: z.array(z.string()).min(1).describe("The choices to pick from.")
  }),
  inputBase.extend({
    kind: z.literal("multiselect").describe("Pick any of `options` → string[] value."),
    options: z.array(z.string()).min(1).describe("The choices to pick from.")
  })
]).describe("Data collected from the human. Discriminated on `kind`.");

const checkBase = z.object({
  id: z.string().min(1).describe("Unique within the step; keys the check result."),
  label: z.string().min(1).describe("Plain-language statement of what passing means, e.g. \"phin-tech/orders-svc#88 is merged\"."),
  owner: z.string().min(1).describe("GitHub repo owner (org or user)."),
  repo: z.string().min(1).describe("GitHub repo name."),
  number: z.number().int().positive().describe("Pull request number.")
});

export const CheckSchema = z.discriminatedUnion("kind", [
  checkBase.extend({
    kind: z.literal("github_pr_review_decision").describe("Passes when the PR's review decision equals `expect`."),
    expect: z.enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"]).default("APPROVED").describe("Required review decision. Defaults to APPROVED.")
  }),
  checkBase.extend({ kind: z.literal("github_pr_merged").describe("Passes when the PR state is MERGED.") })
]).describe("System-owned check auto-evaluated via the `gh` CLI. Not for the human to tick. Discriminated on `kind`.");

// Operator confirmation — a manual checkbox the human ticks. Distinct from data-collection
// inputs; its value persists in StepState.inputs keyed by id.
export const ConfirmSchema = z.object({
  id: z.string().min(1).describe("Unique within the step; keys the confirm's boolean in the result."),
  label: z.string().min(1).describe("What the operator is vouching for, e.g. \"/healthz returns 200\"."),
  required: z.boolean().optional().describe("When true, the step can't be completed until this is ticked.")
}).describe("A manual checkbox the operator ticks. Use for things only a human can verify; use `checks` for anything a machine can.");

// Where a step happens. `repo` renders as a GitHub-style tag; `tool` for non-GitHub systems
// (LaunchDarkly, Slack, Linear, …).
export const SourceSchema = z.object({
  kind: z.enum(["repo", "tool"]).describe("`repo` → blue GitHub-style tag; `tool` → purple tag for non-GitHub systems."),
  label: z.string().min(1).describe("Tag text, e.g. \"phin-tech/orders-svc\" or \"LaunchDarkly · production\"."),
  href: z.string().url().optional().describe("Optional URL — makes the tag a link.")
}).describe("Where the step happens, rendered as a tag.");

const LinkSchema = z.object({
  label: z.string().min(1).describe("Link text."),
  href: z.string().url().describe("Link URL.")
}).describe("A reference link.");

// An alternative way to satisfy a step (e.g. a fallback / rollback). When a step is completed
// on a path whose `outcome` is set, the result records that label instead of plain "done".
export const PathSchema = z.object({
  id: z.string().min(1).describe("Unique within the step."),
  label: z.string().min(1).describe("Shown on the segmented path switch."),
  outcome: z.string().min(1).optional().describe("Recorded in the result when the step is completed on this path (e.g. \"rolled back\"). Omit for the happy path."),
  body: z.string().optional().describe("Path-specific instructions."),
  commands: z.array(z.string().min(1)).optional().describe("Path-specific shell snippets."),
  links: z.array(LinkSchema).optional().describe("Path-specific reference links."),
  confirms: z.array(ConfirmSchema).optional().describe("Path-specific confirms — only the selected path's required confirms gate completion.")
}).describe("An alternative way to satisfy a step (e.g. a fallback / rollback).");

export const StepSchema = z.object({
  id: z.string().min(1).describe("Unique within the task; referenced by other steps' `requires`."),
  title: z.string().min(1).describe("Step heading shown to the operator."),
  askable: z.boolean().default(true).describe("When true, the operator can ask the agent questions from this step. Defaults to true."),
  body: z.string().optional().describe("Prose instructions (newlines preserved)."),
  note: z.string().optional().describe("Collapsible \"from the AI\" callout for context/gotchas."),
  source: SourceSchema.optional(),
  links: z.array(LinkSchema).optional().describe("Reference links."),
  commands: z.array(z.string().min(1)).optional().describe("Shell snippets, each rendered with a copy button."),
  requires: z.array(z.string().min(1)).optional().describe("Step ids that must be done/skipped before this one unlocks."),
  inputs: z.array(InputSchema).optional().describe("Data to collect from the human."),
  confirms: z.array(ConfirmSchema).optional().describe("Operator tick-list (human-verified)."),
  checks: z.array(CheckSchema).optional().describe("System-owned, auto-evaluated checks."),
  paths: z.array(PathSchema).min(2).optional().describe("Two or more alternative ways to satisfy the step."),
  autoCompleteWhen: z.enum(["never", "checks_pass"]).default("never").describe("Auto-mark the step done when all checks pass. Defaults to \"never\".")
}).describe("One unit of work the human does.");

export const TaskSchema = z.object({
  title: z.string().min(1).describe("Shown in the runbook header."),
  steps: z.array(StepSchema).min(1).describe("Ordered steps; at least one.")
}).describe("A handback runbook.");

export const StepStatusSchema = z.enum(["pending", "done", "skipped", "blocked"]);
export const SessionOutcomeSchema = z.enum(["completed", "incomplete", "cancelled"]);

export type Task = z.infer<typeof TaskSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Path = z.infer<typeof PathSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;
export type InputValue = string | boolean | string[];
export type StepQuestion = {
  id: string;
  text: string;
  askedAt: string;
  answer?: string;
  answeredAt?: string;
  updatedAt?: string;
};

export type StepState = {
  status: StepStatus;
  inputs: Record<string, InputValue>;
  questions?: StepQuestion[];
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

export type StepResult = {
  id: string;
  status: StepStatus;
  outcome: string;
  inputs: Record<string, InputValue>;
  selectedPath?: string;
  completedAt?: string;
  skippedAt?: string;
  blockedAt?: string;
  questions?: StepQuestion[];
};

export type SessionResult = {
  sessionId: string;
  outcome?: SessionOutcome;
  finishedAt?: string;
  reason?: string;
  steps: StepResult[];
};

export type QuestionEvent = {
  type: "question";
  sessionId: string;
  stepId: string;
  question: StepQuestion;
};

export const IncludeMarkerSchema = z.object({
  include: z.string().min(1).describe("Name or path of another task file to inline as a sub-plan."),
  as: z.string().min(1).optional().describe("Namespace prefix for the included steps' ids. Defaults to the file's base name."),
  vars: z.record(z.string(), z.string()).optional().describe("Template variables passed to the included file.")
}).describe("Inlines another task file's steps in place, namespaced.");

export const RawTaskSchema = z.object({
  $schema: z.string().optional().describe("Optional JSON Schema URL for editor validation; ignored at runtime."),
  title: z.string().min(1).describe("Shown in the runbook header."),
  steps: z.array(z.union([StepSchema, IncludeMarkerSchema])).min(1).describe("Ordered steps and/or include markers; at least one.")
}).describe("A handback runbook as authored on disk, before include markers are resolved.");

export type RawTask = z.infer<typeof RawTaskSchema>;
export type IncludeMarker = z.infer<typeof IncludeMarkerSchema>;

export function parseRawTask(input: unknown): RawTask {
  return RawTaskSchema.parse(input);
}

export type ValidationIssue = { path: string; message: string };
export type ValidationReport =
  | { ok: false; issues: ValidationIssue[] }
  | { ok: true; parsed: RawTask; unknownKeys: string[] };

// Structural validation of a parsed task object against RawTaskSchema (include markers allowed).
// On success also reports keys present in the input that the schema doesn't define — runtime
// parsing silently strips these, so a typo'd field name (e.g. `titel`) would otherwise vanish.
// Cross-step checks (duplicate ids, unknown `requires`, include resolution) run separately via
// parseTask/resolveIncludes once includes are loaded.
export function validateRawTask(input: unknown): ValidationReport {
  const result = RawTaskSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, issues: refineIssues(input, result.error.issues) };
  }
  return { ok: true, parsed: result.data, unknownKeys: collectUnknownKeys(input, result.data, []) };
}

// A step entry is a `z.union([StepSchema, IncludeMarkerSchema])`, so a malformed step collapses
// to a single vague "Invalid input" at `steps[i]`. Re-validate each offending entry against the
// branch it's clearly aiming at (an `include` key ⇒ include marker, else a step) so the agent
// gets the real reason — which field is missing or mistyped.
function refineIssues(input: unknown, issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): ValidationIssue[] {
  const steps = isPlainObject(input) && Array.isArray(input.steps) ? input.steps : undefined;
  const out: ValidationIssue[] = [];
  const refined = new Set<number>();

  for (const issue of issues) {
    const [head, index] = issue.path;
    if (steps && head === "steps" && typeof index === "number" && isPlainObject(steps[index])) {
      if (!refined.has(index)) {
        refined.add(index);
        const branch = "include" in steps[index] ? IncludeMarkerSchema : StepSchema;
        const branchResult = branch.safeParse(steps[index]);
        if (!branchResult.success) {
          for (const sub of branchResult.error.issues) {
            out.push({ path: formatPath(["steps", index, ...sub.path]), message: sub.message });
          }
        }
      }
      continue;
    }
    out.push({ path: formatPath(issue.path), message: issue.message });
  }

  return out;
}

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "(root)";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keys in `input` absent from the schema-parsed `parsed` were stripped — collect their paths.
function collectUnknownKeys(input: unknown, parsed: unknown, path: PropertyKey[]): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    const out: string[] = [];
    for (let i = 0; i < input.length; i += 1) out.push(...collectUnknownKeys(input[i], parsed[i], [...path, i]));
    return out;
  }
  if (isPlainObject(input) && isPlainObject(parsed)) {
    const out: string[] = [];
    for (const key of Object.keys(input)) {
      if (!(key in parsed)) out.push(formatPath([...path, key]));
      else out.push(...collectUnknownKeys(input[key], parsed[key], [...path, key]));
    }
    return out;
  }
  return [];
}

export function applyVars(json: string, vars: Record<string, string>): string {
  return json.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`Missing template variable: {{${key}}}`);
    return vars[key];
  });
}

export async function resolveIncludes(
  raw: RawTask,
  loadPlan: (src: string, vars: Record<string, string>) => Promise<Task>
): Promise<Task> {
  const resolvedSteps: Step[] = [];

  for (const entry of raw.steps) {
    if ("include" in entry) {
      const ns = entry.as ?? defaultNamespace(entry.include);
      const subTask = await loadPlan(entry.include, entry.vars ?? {});
      const subIds = new Set(subTask.steps.map((s) => s.id));
      for (const step of subTask.steps) {
        resolvedSteps.push(prefixStep(step, ns, subIds));
      }
    } else {
      resolvedSteps.push(entry);
    }
  }

  return parseTask({ title: raw.title, steps: resolvedSteps });
}

function defaultNamespace(src: string): string {
  return src.replace(/.*\//, "").replace(/\.json$/, "");
}

function prefixStep(step: Step, ns: string, subIds: Set<string>): Step {
  return {
    ...step,
    id: `${ns}.${step.id}`,
    requires: step.requires?.map((r) => (subIds.has(r) ? `${ns}.${r}` : r))
  };
}

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
        ...current,
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

  const nextInputs = { ...current.inputs, ...(input.inputs ?? {}) };
  const nextSelectedPath = input.selectedPath ?? current.selectedPath;
  if (current.status === "pending" && hasRequiredFields(step, nextSelectedPath) && requiredFieldsSet(step, nextInputs, nextSelectedPath)) {
    return applyHumanStepUpdate(session, { stepId: input.stepId, status: "done", inputs: nextInputs, selectedPath: nextSelectedPath, now: input.now });
  }

  return {
    ...session,
    steps: {
      ...session.steps,
      [input.stepId]: {
        ...current,
        inputs: nextInputs,
        selectedPath: nextSelectedPath,
        updatedAt: input.now
      }
    }
  };
}

export function appendQuestion(
  session: Session,
  input: { stepId: string; id: string; text: string; now: string }
): Session {
  const step = session.task.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) throw new Error(`Unknown step: ${input.stepId}`);
  if (step.askable === false) throw new Error(`Step is not askable: ${input.stepId}`);
  const current = session.steps[input.stepId];
  if (!current) throw new Error(`Missing state for step: ${input.stepId}`);
  const text = input.text.trim();
  if (!text) throw new Error("Question text is required");

  return {
    ...session,
    steps: {
      ...session.steps,
      [input.stepId]: {
        ...current,
        questions: [...(current.questions ?? []), { id: input.id, text, askedAt: input.now }],
        updatedAt: input.now
      }
    }
  };
}

export function answerQuestion(
  session: Session,
  input: { questionId: string; answer: string; now: string }
): Session {
  const answer = input.answer.trim();
  if (!answer) throw new Error("Answer text is required");

  for (const [stepId, state] of Object.entries(session.steps)) {
    const questions = state.questions ?? [];
    const idx = questions.findIndex((question) => question.id === input.questionId);
    if (idx === -1) continue;
    const current = questions[idx];
    const nextQuestion: StepQuestion = {
      ...current,
      answer,
      answeredAt: current.answeredAt ?? input.now,
      updatedAt: current.answer === undefined ? current.updatedAt : input.now
    };
    return {
      ...session,
      steps: {
        ...session.steps,
        [stepId]: {
          ...state,
          questions: questions.map((question, i) => (i === idx ? nextQuestion : question)),
          updatedAt: input.now
        }
      }
    };
  }

  throw new Error(`Unknown question: ${input.questionId}`);
}

export function nextQuestionEvent(session: Session): QuestionEvent | undefined {
  for (const step of session.task.steps) {
    for (const question of session.steps[step.id]?.questions ?? []) {
      if (question.answer === undefined) return { type: "question", sessionId: session.id, stepId: step.id, question };
    }
  }
  return undefined;
}

export function updateStep(
  session: Session,
  input: { stepId: string; patch: Partial<Step>; now: string }
): Session {
  if (input.patch.id !== undefined && input.patch.id !== input.stepId) throw new Error("Agent update cannot change step id");
  const idx = session.task.steps.findIndex((step) => step.id === input.stepId);
  if (idx === -1) throw new Error(`Unknown step: ${input.stepId}`);

  const steps = session.task.steps.map((step, i) => (i === idx ? { ...step, ...input.patch, id: input.stepId } : step));
  const task = parseTask({ ...session.task, steps });
  const state = session.steps[input.stepId];
  return {
    ...session,
    task,
    steps: {
      ...session.steps,
      [input.stepId]: { ...state, updatedAt: input.now }
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

export function buildResult(session: Session): SessionResult {
  const result: SessionResult = {
    sessionId: session.id,
    outcome: session.outcome,
    finishedAt: session.finishedAt,
    steps: session.task.steps.map((step) => {
      const state = session.steps[step.id];
      const base = {
        id: step.id,
        status: state.status,
        outcome: stepOutcome(step, state),
        inputs: state.inputs,
        selectedPath: state.selectedPath,
        completedAt: state.completedAt,
        skippedAt: state.skippedAt,
        blockedAt: state.blockedAt
      };
      return state.questions?.length ? { ...base, questions: state.questions } : base;
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

function hasRequiredFields(step: Step, selectedPath?: string): boolean {
  return Boolean(step.inputs?.some((input) => input.required) || step.confirms?.some((confirm) => confirm.required) || effectivePath(step, selectedPath)?.confirms?.some((confirm) => confirm.required));
}

function requiredFieldsSet(step: Step, inputs: Record<string, InputValue>, selectedPath?: string): boolean {
  try {
    assertRequiredFields(step, inputs, selectedPath);
    return true;
  } catch {
    return false;
  }
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
