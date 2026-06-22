import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

test("demo page local assets exist", async () => {
  const demoPath = "docs/public/demo.html";
  const html = await readFile(demoPath, "utf8");
  const refs = [...html.matchAll(/\b(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]);

  assert.ok(refs.length > 0);

  for (const ref of refs) {
    assert.ok(existsSync(join(dirname(demoPath), ref)), `missing demo asset: ${ref}`);
  }
});
