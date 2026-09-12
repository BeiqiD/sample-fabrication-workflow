import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { verificationPlan, executeVerification, contextOutcome } from "./verification-plan.mjs";
import { publishCommitStatus } from "./publish-commit-status.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
const mode = argument("--mode", "ci");
const statusOnly = argument("--status", null);
const plan = verificationPlan(mode);
if (process.argv.includes("--list")) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  const previousStatuses = new Map();
  async function report(outcomes) {
    if (process.env.VERIFY_PUBLISH_STATUSES !== "1") return;
    await Promise.all(Object.entries(plan.contexts).map(async ([context, dependencies]) => {
      const outcome = contextOutcome(dependencies, outcomes);
      if (previousStatuses.get(context) === outcome) return;
      const failed = dependencies.find((id) => outcomes[id] === "failure");
      try {
        await publishCommitStatus({
          ...process.env,
          STAGE_OUTCOME: outcome,
          STATUS_CONTEXT: context,
          STATUS_SUCCESS_DESCRIPTION: "All required verification checks passed",
          STATUS_FAILURE_DESCRIPTION: `${failed || "Verification"} failed; see workflow log`,
        });
        previousStatuses.set(context, outcome);
      } catch (error) {
        // The Actions job is authoritative even if GitHub status publication is unavailable.
        console.warn(`Could not publish ${context}: ${error.message}`);
      }
    }));
  }
  if (statusOnly) {
    if (!["pending", "skipped", "cancelled"].includes(statusOnly)) throw new Error(`Invalid status-only outcome: ${statusOnly}`);
    await report(Object.fromEntries(plan.leaves.map(({ id }) => [id, statusOnly])));
  } else {
    const result = await executeVerification(plan, (leaf) => new Promise((accept, reject) => {
      console.log(`Running ${leaf.id}: npm run ${leaf.script}`);
      const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", leaf.script], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${leaf.id}: ${signal || code}`)));
    }), report);
    const rows = plan.leaves.map(({ id }) => `| ${id} | ${result.outcomes[id]} | ${result.durations[id] ?? "—"} |`);
    const summary = ["## Verification checks", "", "| Check | Outcome | Duration (ms) |", "|---|---|---:|", ...rows, ""].join("\n");
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    if (!result.success) process.exitCode = 1;
  }
}
