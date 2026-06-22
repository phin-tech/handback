// Regenerates the task JSON Schema from the Zod schema. Run with the tsx loader
// (`node --import tsx scripts/gen-schema.mjs`) so it reads straight from src/ and needs no build —
// the build pipeline and the prek pre-commit hook both invoke it this way. Written to two
// committed locations from one source so they can't drift:
//   - schema/task.schema.json                          → shipped in the npm package; $schema URL target
//   - skills/handback-runbooks/references/…            → bundled with the skill, so an agent that
//     installed the skill has the full field spec locally (relative-referenced from SKILL.md)
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskJsonSchema } from "../src/schema.js";

const contents = JSON.stringify(buildTaskJsonSchema(), null, 2) + "\n";
const targets = [
  new URL("../schema/task.schema.json", import.meta.url),
  new URL("../skills/handback-runbooks/references/task.schema.json", import.meta.url)
];

for (const target of targets) {
  const out = fileURLToPath(target);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, contents);
  console.log(`Wrote ${out}`);
}
