import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STAGES = {
  A: { predecessor: "legacy", rollbackFloor: "legacy", schema: false, textWrites: false },
  E: { predecessor: "A", rollbackFloor: "A", schema: false, textWrites: false },
  B: { predecessor: "E", rollbackFloor: "E", schema: true, textWrites: true },
  C: { predecessor: "B", rollbackFloor: "B", schema: false, textWrites: true },
  D: { predecessor: "C", rollbackFloor: "C", schema: true, textWrites: false },
};
const MODES = new Set(["remote-preflight", "isolated-qualification"]);
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CONTEXT_MAX_AGE_MS = 5 * 60_000;
const REPORT_MAX_AGE_MS = 24 * 60 * 60_000;

function reject(code, message) {
  const error = new Error(`Compatibility preflight rejected: ${message}`);
  error.code = code;
  throw error;
}

function record(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid-input", `${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) reject("invalid-input", `${label} has missing or unsupported fields`);
  return value;
}

function matches(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) reject("invalid-input", `invalid ${label}`);
}

function timestamp(value, label) {
  if (typeof value !== "string") reject("invalid-input", `invalid ${label}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) reject("invalid-input", `${label} must be an exact UTC ISO timestamp`);
  return parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) reject("context-mismatch", `${label} does not match current reviewed context`);
}

function target(value, label) {
  record(value, ["environment", "accountId", "workerName", "databaseId"], label);
  matches(value.environment, /^[a-z0-9][a-z0-9-]{0,63}$/, `${label}.environment`);
  matches(value.accountId, /^[a-f0-9]{32}$/, `${label}.accountId`);
  matches(value.workerName, /^[a-z0-9][a-z0-9-]{0,62}$/, `${label}.workerName`);
  matches(value.databaseId, UUID, `${label}.databaseId`);
}

function predecessor(value, label) {
  record(value, ["stage", "sourceCommit", "schemaSha256", "deploymentId"], label);
  if (!["legacy", "A", "E", "B", "C"].includes(value.stage)) reject("invalid-input", `invalid ${label}.stage`);
  matches(value.sourceCommit, GIT_SHA, `${label}.sourceCommit`);
  matches(value.schemaSha256, SHA256, `${label}.schemaSha256`);
  matches(value.deploymentId, UUID, `${label}.deploymentId`);
}

// This digest binds a proposal to its environment, predecessor and mode. It is
// an integrity reference, not a signature, provider observation or permission.
export function compatibilityTransitionDigest(proposal) {
  return createHash("sha256").update(canonical({
    formatVersion: proposal.formatVersion,
    mode: proposal.mode,
    target: proposal.target,
    predecessor: proposal.predecessor,
    transition: proposal.transition,
  })).digest("hex");
}

/** Pure validation only. Neither supplied context nor hashes attest remote state. */
export function assessCompatibilityStage(proposal, context, now = Date.now()) {
  if (proposal && typeof proposal === "object" && Object.hasOwn(proposal, "providerProof")) {
    reject("unsupported-provider-proof", "no provider retirement proof protocol is supported, including an empty or self-declared proof");
  }
  record(proposal, ["formatVersion", "mode", "target", "predecessor", "transition", "qualification"], "proposal");
  record(context, ["formatVersion", "mode", "target", "current", "observedAt", "approvedTransitionSha256", "approvedReportSha256"], "context");
  if (proposal.formatVersion !== 1 || context.formatVersion !== 1) reject("unsupported-version", "only formatVersion 1 is supported");
  if (!MODES.has(proposal.mode) || !MODES.has(context.mode)) reject("invalid-input", "unsupported mode");
  same(proposal.mode, context.mode, "mode");
  target(proposal.target, "proposal.target");
  target(context.target, "context.target");
  same(proposal.target, context.target, "target");
  predecessor(proposal.predecessor, "proposal.predecessor");
  predecessor(context.current, "context.current");
  same(proposal.predecessor, context.current, "predecessor");

  const transition = record(proposal.transition, ["stage", "sourceCommit", "sourceTree", "artifactSha256", "migrationSha256", "fromSchemaSha256", "toSchemaSha256", "rollbackFloor", "changesTextWrites"], "transition");
  const rule = typeof transition.stage === "string" && Object.hasOwn(STAGES, transition.stage) ? STAGES[transition.stage] : undefined;
  if (!rule) reject("invalid-stage", "unsupported stage");
  if (proposal.predecessor.stage !== rule.predecessor) reject("invalid-stage", "stage must follow its exact predecessor");
  if (transition.rollbackFloor !== rule.rollbackFloor) reject("invalid-stage", "rollback floor does not match the stage barrier");
  if (transition.changesTextWrites !== rule.textWrites) reject("invalid-stage", "text-write behavior does not match the stage");
  matches(transition.sourceCommit, GIT_SHA, "transition.sourceCommit");
  matches(transition.sourceTree, GIT_SHA, "transition.sourceTree");
  for (const key of ["artifactSha256", "fromSchemaSha256", "toSchemaSha256"]) matches(transition[key], SHA256, `transition.${key}`);
  same(transition.fromSchemaSha256, context.current.schemaSha256, "source schema");
  if (rule.schema) {
    matches(transition.migrationSha256, SHA256, "transition.migrationSha256");
    if (transition.fromSchemaSha256 === transition.toSchemaSha256) reject("invalid-stage", "schema-changing stage must have distinct schema fingerprints");
  } else if (transition.migrationSha256 !== null || transition.fromSchemaSha256 !== transition.toSchemaSha256) {
    reject("invalid-stage", "this stage must preserve schema and have no migration");
  }

  const qualification = record(proposal.qualification, ["kind", "transitionSha256", "reportSha256", "createdAt"], "qualification");
  if (qualification.kind !== "isolated") reject("invalid-input", "qualification must refer to an isolated rehearsal");
  for (const [value, label] of [
    [qualification.transitionSha256, "qualification.transitionSha256"],
    [qualification.reportSha256, "qualification.reportSha256"],
    [context.approvedTransitionSha256, "context.approvedTransitionSha256"],
    [context.approvedReportSha256, "context.approvedReportSha256"],
  ]) matches(value, SHA256, label);
  const digest = compatibilityTransitionDigest(proposal);
  same(qualification.transitionSha256, digest, "qualification transition");
  same(context.approvedTransitionSha256, digest, "reviewed transition");
  same(qualification.reportSha256, context.approvedReportSha256, "reviewed report");

  if (!Number.isSafeInteger(now) || now < 0) reject("invalid-input", "now must be epoch milliseconds");
  const observedAt = timestamp(context.observedAt, "context.observedAt");
  const createdAt = timestamp(qualification.createdAt, "qualification.createdAt");
  if (observedAt > now || now - observedAt > CONTEXT_MAX_AGE_MS) reject("stale-evidence", "context is future-dated or older than five minutes");
  if (createdAt > observedAt || now - createdAt > REPORT_MAX_AGE_MS) reject("stale-evidence", "qualification must precede the context observation and be at most 24 hours old");

  const blocked = proposal.mode === "remote-preflight" && ["B", "C", "D"].includes(transition.stage);
  return {
    formatVersion: 1,
    stage: transition.stage,
    mode: proposal.mode,
    status: blocked ? "blocked" : proposal.mode === "isolated-qualification" ? "isolated-qualification-proposal" : "compatible-transition-proposal",
    reason: blocked ? "unobservable-pre-instrumentation-cohort" : "validated-input-associations-only",
    transitionSha256: digest,
    executionAuthorized: false,
    remoteMutationAuthorized: false,
    limitations: [
      "Supplied context and report references do not attest current provider state or test success.",
      "No supported provider retirement proof protocol exists in this gate.",
      "No result authorizes deployment, migration, a data-mode change or a resource operation.",
    ],
  };
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--proposal" || args[2] !== "--context") {
    reject("invalid-arguments", "usage: node scripts/compatibility-stage-gate.mjs --proposal <json> --context <json>");
  }
  const [proposal, context] = await Promise.all([args[1], args[3]].map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const result = assessCompatibilityStage(proposal, context);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "blocked") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "rejected", code: error.code ?? "invalid-input", message: error.message, executionAuthorized: false, remoteMutationAuthorized: false })}\n`);
    process.exitCode = 1;
  });
}
