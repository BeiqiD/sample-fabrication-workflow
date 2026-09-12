// Leaf checks are shared by CI and deployment. Domain scripts remain convenient
// local entry points; the complete gate runs each underlying check only once.
const testLeaves = ["verification-scripts", "source", "mounted", "rich-text"];
const mapLeaves = ["source", "mounted", "build", "map-bundle"];
const mutationLeaves = [...mapLeaves, "project-worker"];
export const verificationContexts = {
  "pre-pr/blob-lifecycle": ["source", "export-contract", "migrations"],
  "pre-pr/reference-foundation": ["source", "mounted", "reference-worker", "reference-search-worker"],
  "pre-pr/project-foundation": ["source"],
  "pre-pr/project-persistence": ["source", "migrations", "project-worker"],
  "pre-pr/project-map": mapLeaves,
  "pre-pr/project-canvas-productivity": mutationLeaves,
  "pre-pr/project-reference-placement": mapLeaves,
  "pre-pr/project-owned-content": mutationLeaves,
  "pre-pr/project-edges": mutationLeaves,
  "pre-pr/project-reading": mutationLeaves,
  "pre-pr/tests": testLeaves,
  "pre-pr/build": ["build"],
};

export function verificationPlan(mode) {
  if (!["ci", "deploy", "map-performance"].includes(mode)) throw new Error(`Unknown verification mode: ${mode}`);
  if (mode === "map-performance") return {
    leaves: [
      { id: "source", script: "test:project-map-performance" },
      { id: "mounted", script: "test:project-map-performance-mounted" },
      { id: "build", script: "build" },
      { id: "map-bundle", script: "test:project-map-bundle" },
    ],
    contexts: { "pre-pr/project-map-performance": mapLeaves },
  };
  return {
    leaves: [
      { id: "verification-scripts", script: "test:verification-scripts" },
      { id: "source", script: "test:source" },
      { id: "mounted", script: "test:reference-mounted" },
      { id: "rich-text", script: "test:rich-text-bundle" },
      { id: "export-contract", script: "typecheck:export-contract" },
      { id: "migrations", script: "verify:d1-migrations" },
      { id: "reference-worker", script: "verify:reference-worker" },
      { id: "reference-search-worker", script: "verify:reference-search-worker" },
      { id: "build", script: mode === "deploy" ? "build:deploy" : "build" },
      { id: "map-bundle", script: "test:project-map-bundle" },
      { id: "project-worker", script: "verify:project-worker-artifact" },
    ],
    contexts: verificationContexts,
  };
}

export function contextOutcome(dependencies, outcomes) {
  if (dependencies.some((id) => outcomes[id] === "failure")) return "failure";
  if (dependencies.some((id) => outcomes[id] === "cancelled")) return "cancelled";
  if (dependencies.some((id) => outcomes[id] === "skipped")) return "skipped";
  return dependencies.every((id) => outcomes[id] === "success") ? "success" : "pending";
}

export async function executeVerification(plan, execute, onProgress = async () => {}) {
  const outcomes = Object.fromEntries(plan.leaves.map(({ id }) => [id, "pending"]));
  const durations = {};
  await onProgress(outcomes, durations);
  let failed = false;
  for (const leaf of plan.leaves) {
    if (failed) { outcomes[leaf.id] = "skipped"; continue; }
    const started = Date.now();
    try { await execute(leaf); outcomes[leaf.id] = "success"; }
    catch { outcomes[leaf.id] = "failure"; failed = true; }
    durations[leaf.id] = Date.now() - started;
    await onProgress(outcomes, durations);
  }
  await onProgress(outcomes, durations);
  return { outcomes, durations, success: !failed };
}
