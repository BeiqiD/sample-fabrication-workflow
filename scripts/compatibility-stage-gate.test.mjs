import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assessCompatibilityStage, compatibilityTransitionDigest } from "./compatibility-stage-gate.mjs";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const sha = (digit) => digit.repeat(64);
const git = (digit) => digit.repeat(40);
const uuid = "00000000-0000-4000-8000-000000000000";
const predecessors = { A: "legacy", E: "A", B: "E", C: "B", D: "C" };

function fixture(stage = "A", mode = "remote-preflight", now = NOW) {
  const schemaChange = ["B", "D"].includes(stage);
  const proposal = {
    formatVersion: 1,
    mode,
    target: { environment: "v3-test", accountId: "a".repeat(32), workerName: "synthetic-worker", databaseId: uuid },
    predecessor: { stage: predecessors[stage], sourceCommit: git("1"), schemaSha256: sha("2"), deploymentId: uuid },
    transition: {
      stage,
      sourceCommit: git("3"),
      sourceTree: git("4"),
      artifactSha256: sha("5"),
      migrationSha256: schemaChange ? sha("6") : null,
      fromSchemaSha256: sha("2"),
      toSchemaSha256: schemaChange ? sha("7") : sha("2"),
      rollbackFloor: predecessors[stage],
      changesTextWrites: ["B", "C"].includes(stage),
    },
    qualification: { kind: "isolated", transitionSha256: "", reportSha256: sha("8"), createdAt: new Date(now - 60_000).toISOString() },
  };
  const digest = compatibilityTransitionDigest(proposal);
  proposal.qualification.transitionSha256 = digest;
  const context = {
    formatVersion: 1,
    mode,
    target: structuredClone(proposal.target),
    current: structuredClone(proposal.predecessor),
    observedAt: new Date(now).toISOString(),
    approvedTransitionSha256: digest,
    approvedReportSha256: sha("8"),
  };
  return { proposal, context };
}

function approveAssociations(proposal, context) {
  const digest = compatibilityTransitionDigest(proposal);
  proposal.qualification.transitionSha256 = digest;
  context.approvedTransitionSha256 = digest;
}

function rejects(proposal, context, code) {
  assert.throws(() => assessCompatibilityStage(proposal, context, NOW), (error) => error.code === code);
}

test("A/E permit only compatible proposals, never execution or remote mutation", () => {
  for (const stage of ["A", "E"]) {
    const { proposal, context } = fixture(stage);
    const result = assessCompatibilityStage(proposal, context, NOW);
    assert.equal(result.status, "compatible-transition-proposal");
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.remoteMutationAuthorized, false);
    assert.match(result.limitations.join(" "), /do not attest current provider state or test success/);
    for (const change of [
      (value) => { value.transition.toSchemaSha256 = sha("9"); },
      (value) => { value.transition.migrationSha256 = sha("9"); },
      (value) => { value.transition.changesTextWrites = true; },
    ]) {
      const changed = structuredClone(proposal);
      change(changed);
      approveAssociations(changed, context);
      rejects(changed, context, "invalid-stage");
    }
  }
});

test("B/C/D remote remain blocked even with internally consistent, fresh, fully approved references", () => {
  for (const stage of ["B", "C", "D"]) {
    const { proposal, context } = fixture(stage);
    const before = JSON.stringify({ proposal, context });
    const result = assessCompatibilityStage(proposal, context, NOW);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unobservable-pre-instrumentation-cohort");
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.remoteMutationAuthorized, false);
    assert.equal(JSON.stringify({ proposal, context }), before);
    // Even a later fresh observation and a freshly associated report cannot
    // transform elapsed time into proof about an unregistered historical cohort.
    const later = NOW + 30 * 24 * 60 * 60_000;
    const fresh = fixture(stage, "remote-preflight", later);
    assert.equal(assessCompatibilityStage(fresh.proposal, fresh.context, later).status, "blocked");
  }
});

test("all stages can describe isolated qualification without granting execution", () => {
  for (const stage of Object.keys(predecessors)) {
    const { proposal, context } = fixture(stage, "isolated-qualification");
    const result = assessCompatibilityStage(proposal, context, NOW);
    assert.equal(result.status, "isolated-qualification-proposal");
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.remoteMutationAuthorized, false);
  }
});

test("drain flags, receipts, timeout claims and all provider proof versions are rejected", () => {
  for (const key of ["drained", "receipt", "waitedSeconds", "executionAuthorized"]) {
    const { proposal, context } = fixture("D");
    proposal[key] = key === "waitedSeconds" ? 99999999 : true;
    rejects(proposal, context, "invalid-input");
  }
  for (const proof of [null, {}, { protocolVersion: 1, drained: true }, { protocolVersion: 999, signature: "self-declared" }]) {
    const { proposal, context } = fixture("D");
    proposal.providerProof = proof;
    rejects(proposal, context, "unsupported-provider-proof");
  }
  for (const owner of ["transition", "qualification", "predecessor", "target"]) {
    const { proposal, context } = fixture("D");
    proposal[owner].drained = true;
    rejects(proposal, context, "invalid-input");
  }
});

test("predecessor order, rollback floor and schema/write behavior cannot be relabelled", () => {
  for (const stage of Object.keys(predecessors)) {
    for (const change of [
      (proposal, context) => { proposal.predecessor.stage = stage === "A" ? "C" : "legacy"; context.current.stage = proposal.predecessor.stage; },
      (proposal) => { proposal.transition.rollbackFloor = "D"; },
      (proposal) => { proposal.transition.changesTextWrites = !proposal.transition.changesTextWrites; },
      (proposal) => { proposal.transition.migrationSha256 = ["B", "D"].includes(stage) ? null : sha("9"); },
      (proposal) => { proposal.transition.toSchemaSha256 = ["B", "D"].includes(stage) ? sha("2") : sha("9"); },
    ]) {
      const { proposal, context } = fixture(stage);
      change(proposal, context);
      approveAssociations(proposal, context);
      assert.throws(() => assessCompatibilityStage(proposal, context, NOW));
    }
  }
});

test("qualification cannot move to a different environment, stage, mode or artifact", () => {
  const original = fixture("B");
  for (const stage of ["A", "E", "C", "D"]) {
    const { proposal, context } = fixture(stage);
    proposal.qualification = structuredClone(original.proposal.qualification);
    rejects(proposal, context, "context-mismatch");
  }
  const isolated = fixture("B", "isolated-qualification");
  isolated.proposal.qualification = structuredClone(original.proposal.qualification);
  rejects(isolated.proposal, isolated.context, "context-mismatch");
  for (const key of ["environment", "accountId", "workerName", "databaseId"]) {
    const { proposal, context } = fixture("B");
    context.target[key] = { environment: "another", accountId: "b".repeat(32), workerName: "another-worker", databaseId: "10000000-0000-4000-8000-000000000000" }[key];
    rejects(proposal, context, "context-mismatch");
    // Moving both target objects still invalidates the original evidence digest.
    proposal.target = structuredClone(context.target);
    rejects(proposal, context, "context-mismatch");
  }
  for (const key of ["sourceCommit", "sourceTree", "artifactSha256", "migrationSha256", "toSchemaSha256"]) {
    const { proposal, context } = fixture("B");
    proposal.transition[key] = ["sourceCommit", "sourceTree"].includes(key) ? git("9") : sha("9");
    rejects(proposal, context, "context-mismatch");
  }
});

test("fresh context binds current deployment, source and schema as well as the report hash", () => {
  for (const key of ["sourceCommit", "schemaSha256", "deploymentId"]) {
    const { proposal, context } = fixture("C");
    context.current[key] = key === "deploymentId" ? "10000000-0000-4000-8000-000000000000" : key === "sourceCommit" ? git("9") : sha("9");
    rejects(proposal, context, "context-mismatch");
  }
  const { proposal, context } = fixture("B");
  proposal.transition.fromSchemaSha256 = sha("9");
  approveAssociations(proposal, context);
  rejects(proposal, context, "context-mismatch");
  for (const key of ["approvedTransitionSha256", "approvedReportSha256"]) {
    const fresh = fixture();
    fresh.context[key] = sha("9");
    rejects(fresh.proposal, fresh.context, "context-mismatch");
  }
});

test("stale, future and non-canonical times are rejected without a caller timeout override", () => {
  for (const change of [
    (_, context) => { context.observedAt = new Date(NOW - 300_001).toISOString(); },
    (_, context) => { context.observedAt = new Date(NOW + 1).toISOString(); },
    (proposal) => { proposal.qualification.createdAt = new Date(NOW - 86_400_001).toISOString(); },
    (proposal) => { proposal.qualification.createdAt = new Date(NOW + 1).toISOString(); },
  ]) {
    const { proposal, context } = fixture();
    change(proposal, context);
    rejects(proposal, context, "stale-evidence");
  }
  const { proposal, context } = fixture();
  context.observedAt = "2026-09-13T12:00:00Z";
  rejects(proposal, context, "invalid-input");
  context.observedAt = new Date(NOW).toISOString();
  context.maxAgeMs = Infinity;
  rejects(proposal, context, "invalid-input");
});

test("strict versions, required fields and hash shapes reject malformed or future formats", () => {
  for (const owner of ["proposal", "context"]) {
    const values = fixture();
    values[owner].formatVersion = 2;
    rejects(values.proposal, values.context, "unsupported-version");
  }
  for (const bad of ["short", "A".repeat(40), "1".repeat(64), null, 123]) {
    const { proposal, context } = fixture();
    proposal.transition.sourceCommit = bad;
    rejects(proposal, context, "invalid-input");
  }
  const { proposal, context } = fixture();
  delete proposal.transition.rollbackFloor;
  rejects(proposal, context, "invalid-input");
});

test("non-string stage values cannot coerce into a rule and evade the remote block", () => {
  for (const stage of ["B", "C", "D"]) {
    for (const value of [[stage], [[stage]], null, 0, { toString: stage }]) {
      const { proposal, context } = fixture(stage);
      proposal.transition.stage = value;
      approveAssociations(proposal, context);
      rejects(proposal, context, "invalid-stage");
    }
  }
});

test("CLI is read-only, distinguishes blocked from malformed input, and writes no receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compatibility-stage-gate-"));
  try {
    const proposalPath = join(directory, "proposal.json");
    const contextPath = join(directory, "context.json");
    const script = new URL("./compatibility-stage-gate.mjs", import.meta.url).pathname;
    for (const [stage, expectedStatus, expectedExit] of [["A", "compatible-transition-proposal", 0], ["B", "blocked", 2], ["C", "blocked", 2], ["D", "blocked", 2]]) {
      const { proposal, context } = fixture(stage, "remote-preflight", Date.now());
      await writeFile(proposalPath, JSON.stringify(proposal));
      await writeFile(contextPath, JSON.stringify(context));
      const bytes = await Promise.all([proposalPath, contextPath].map((path) => readFile(path, "utf8")));
      const result = spawnSync(process.execPath, [script, "--proposal", proposalPath, "--context", contextPath], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, expectedExit, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, expectedStatus);
      assert.equal(output.executionAuthorized, false);
      assert.deepEqual(await readdir(directory), ["context.json", "proposal.json"]);
      assert.deepEqual(await Promise.all([proposalPath, contextPath].map((path) => readFile(path, "utf8"))), bytes);
    }
    const malformed = spawnSync(process.execPath, [script, "--deploy"], { cwd: directory, encoding: "utf8" });
    assert.equal(malformed.status, 1);
    assert.equal(JSON.parse(malformed.stderr).executionAuthorized, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
