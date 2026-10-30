import assert from "node:assert/strict";
import { test } from "node:test";
import { commitStatusBody, publishCommitStatus } from "./publish-commit-status.mjs";

test("one SHA transitions pending, failure, success on the same required context", async () => {
  const requests = [];
  const env = { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "same-sha", GITHUB_RUN_ID: "123", STATUS_CONTEXT: "pre-pr/tests", STATUS_DYNAMIC_FAILURE_CONTEXT: "1" };
  for (const outcome of ["pending", "failure", "success"]) {
    await publishCommitStatus({ ...env, STAGE_OUTCOME: outcome }, async (url, request) => {
      requests.push({ url, body: JSON.parse(request.body) });
      return new Response("{}", { status: 201 });
    });
  }
  assert.deepEqual(requests.map(({ body }) => body.context), ["pre-pr/tests", "pre-pr/tests", "pre-pr/tests"]);
  assert.deepEqual(requests.map(({ body }) => body.state), ["pending", "failure", "success"]);
  assert.equal(new Set(requests.map(({ url }) => url)).size, 1);
  assert.equal(requests.at(-1).body.target_url, "https://github.com/owner/repo/actions/runs/123");
});

test("skipped and cancelled verification never preserve a successful result", () => {
  for (const outcome of ["skipped", "cancelled"]) {
    assert.equal(commitStatusBody({ outcome, context: "pre-pr/build", detail: "not executed" }).state, "error");
  }
  assert.throws(() => commitStatusBody({ outcome: "unexpected", context: "x", detail: "x" }), /Unknown/);
});

test("transient publication retries but rejected credentials do not", async () => {
  const env = { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "sha", STATUS_CONTEXT: "pre-pr/build", STAGE_OUTCOME: "success" };
  let attempts = 0;
  await publishCommitStatus(env, async () => new Response("{}", { status: ++attempts === 1 ? 503 : 201 }), async () => {});
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(() => publishCommitStatus(env, async () => { attempts++; return new Response("denied", { status: 403 }); }, async () => {}), /403/);
  assert.equal(attempts, 1);
});
