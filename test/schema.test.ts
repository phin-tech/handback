import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import { buildTaskJsonSchema, TASK_SCHEMA_ID } from "../src/schema.js";
import { validateRawTask } from "../src/core.js";

test("buildTaskJsonSchema is a self-identifying, closed object schema", () => {
  const schema = buildTaskJsonSchema() as Record<string, any>;
  assert.equal(schema.$id, TASK_SCHEMA_ID);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.$schema, "permits a $schema key so authored files can self-link");
  assert.equal(schema.properties.title.description, "Shown in the runbook header.");
});

test("schema does not require fields that have runtime defaults", () => {
  const schema = buildTaskJsonSchema() as any;
  const stepBranches: any[] = schema.properties.steps.items.anyOf;
  const stepBranch = stepBranches.find((branch) => branch.properties?.autoCompleteWhen);
  assert.ok(stepBranch, "expected a step branch with autoCompleteWhen");
  assert.ok(!stepBranch.required.includes("autoCompleteWhen"), "autoCompleteWhen has a default; authored tasks may omit it");

  const checkBranches: any[] = stepBranch.properties.checks.items.oneOf;
  const reviewCheck = checkBranches.find((branch) => branch.properties?.expect);
  assert.ok(reviewCheck, "expected a review-decision check branch");
  assert.ok(!reviewCheck.required.includes("expect"), "expect has a default; authored tasks may omit it");
  assert.ok(reviewCheck.required.includes("number"), "non-defaulted check fields stay required");
});

test("committed schema copies match the generated schema", async () => {
  const expected = JSON.stringify(buildTaskJsonSchema(), null, 2) + "\n";
  // Two committed copies, one source: the shipped package file and the skill-bundled mirror.
  for (const file of ["schema/task.schema.json", "skills/handback-runbooks/references/task.schema.json"]) {
    assert.ok(existsSync(file), `${file} missing — run \`npm run build\` (or \`node scripts/gen-schema.mjs\`)`);
    const onDisk = await readFile(file, "utf8");
    assert.equal(onDisk, expected, `${file} is stale — run \`npm run build\` and commit`);
  }
});

test("shipped examples validate against the task schema", async () => {
  for (const file of ["examples/sample-task.json", "examples/cross-service-release.json"]) {
    const report = validateRawTask(JSON.parse(await readFile(file, "utf8")));
    assert.equal(report.ok, true, `${file} should be valid`);
    if (report.ok) assert.deepEqual(report.unknownKeys, [], `${file} has unknown fields`);
  }
});
