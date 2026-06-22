import { z } from "zod";
import { RawTaskSchema } from "./core.js";

// Stable URL a task file can point `$schema` at for editor validation / autocomplete.
export const TASK_SCHEMA_ID = "https://raw.githubusercontent.com/phin-tech/handback/main/schema/task.schema.json";

// The published JSON Schema for a handback task file. Generated from the same Zod schema the
// runtime validates against, so the two never drift. Built from RawTaskSchema (include markers
// allowed) since that's what a hand-authored file may contain.
export function buildTaskJsonSchema(): Record<string, unknown> {
  // `io: "input"` generates the schema for what an author *writes*: fields with Zod defaults
  // (autoCompleteWhen, a check's expect) become optional rather than required, since a task file
  // can omit them. The default "output" mode describes the post-parse shape and would wrongly
  // reject valid authored tasks that lean on those defaults.
  const schema = z.toJSONSchema(RawTaskSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
  // Input mode leaves objects open (extra keys would just be stripped at runtime); re-close them
  // so editors/CI still flag unknown/typo'd fields — the same thing `handback validate` reports.
  closeObjects(schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: TASK_SCHEMA_ID,
    title: "Handback task",
    ...schema
  };
}

// Set `additionalProperties: false` on every fixed-shape object in the schema. Leaves
// `z.record`-style maps (which carry an `additionalProperties` *schema*) untouched.
function closeObjects(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) closeObjects(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.type === "object" && obj.properties && obj.additionalProperties === undefined) {
    obj.additionalProperties = false;
  }
  for (const value of Object.values(obj)) closeObjects(value);
}
