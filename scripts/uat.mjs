import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "handback-uat-"));
const taskPath = join(dir, "uat.json");

await writeFile(
  taskPath,
  `${JSON.stringify(
    {
      title: "Handback UAT",
      steps: [
        {
          id: "open",
          title: "Confirm the checklist opens cleanly",
          body: "Look for the title, progress count, visible first step, and locked follow-up step.",
          confirms: [{ id: "loaded", label: "Checklist opened and is readable", required: true }],
          inputs: [{ id: "first_impression", label: "Anything visually broken?", kind: "textarea" }]
        },
        {
          id: "tee-check",
          title: "Verify tee auto-populated the output field",
          requires: ["open"],
          body: "The 'System info' field below was populated automatically by handback tee before you opened this step. Confirm it contains a value.",
          inputs: [{ id: "sysinfo", label: "System info (auto-populated)", kind: "textarea" }],
          confirms: [{ id: "tee_ok", label: "Auto-populated value is present and readable", required: true }]
        },
        {
          id: "work",
          title: "Exercise the checklist controls",
          requires: ["tee-check"],
          body: "Use at least one text field, one checkbox, and one path option. Confirm the step can be completed.",
          paths: [
            {
              id: "pass",
              label: "Looks good",
              confirms: [{ id: "controls_ok", label: "Controls behaved correctly", required: true }]
            },
            {
              id: "issue",
              label: "Found an issue",
              outcome: "issue found",
              confirms: [{ id: "issue_recorded", label: "Issue is described below", required: true }]
            }
          ],
          inputs: [{ id: "notes", label: "Control notes", kind: "textarea", required: true }]
        },
        {
          id: "finish",
          title: "Finish and return to the agent",
          requires: ["work"],
          body: "Click Finish when everything is done. Use Finish incomplete or Cancel only if the flow is broken.",
          confirms: [{ id: "ready", label: "Ready to finish", required: true }]
        }
      ]
    },
    null,
    2
  )}\n`
);

try {
  const { sessionId, url, token } = await startHandback(taskPath);
  console.error(`Session: ${sessionId}\nURL:     ${url}\n`);

  // Inject the copy-pasteable tee command into the checklist step before the user opens it
  const patchUrl = new URL(`/api/steps/tee-check?token=${encodeURIComponent(token)}`, url);
  await fetch(patchUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: [`echo "$(hostname)" | handback tee ${sessionId} tee-check sysinfo`] })
  });

  const teeContent = `hostname: ${hostname()}\ndate: ${new Date().toISOString()}`;
  await runTee(sessionId, "tee-check", "sysinfo", teeContent);
  console.error(`tee: pre-populated tee-check/sysinfo`);

  const result = await waitHandback(sessionId);
  const issues = review(result);
  console.log("\nUAT review");
  if (issues.length === 0) {
    console.log("PASS");
  } else {
    console.log("FAIL");
    for (const issue of issues) console.log(`- ${issue}`);
    process.exitCode = 1;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

function startHandback(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli.js", "start", path], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`handback start exited ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("handback start did not return JSON"));
      }
    });
  });
}

function waitHandback(sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli.js", "wait", sessionId], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`handback wait exited ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("handback wait did not return JSON"));
      }
    });
  });
}

function runTee(sessionId, stepId, inputId, content) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/src/cli.js", "tee", sessionId, stepId, inputId], {
      stdio: ["pipe", "ignore", "inherit"]
    });
    child.stdin.end(content);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`handback tee exited ${code}`));
      resolve();
    });
  });
}

function review(result) {
  const issues = [];
  if (result.outcome !== "completed") issues.push(`outcome was ${result.outcome}`);
  for (const step of result.steps ?? []) {
    if (step.status !== "done") issues.push(`${step.id} was ${step.status}`);
  }
  if (!String(result.steps?.find((s) => s.id === "work")?.inputs?.notes ?? "").trim()) {
    issues.push("control notes were empty");
  }
  if (!String(result.steps?.find((s) => s.id === "tee-check")?.inputs?.sysinfo ?? "").trim()) {
    issues.push("tee-check/sysinfo was not populated");
  }
  return issues;
}
