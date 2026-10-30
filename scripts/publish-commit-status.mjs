import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function commitStatusBody({ outcome, context, detail, targetUrl }) {
  const states = { pending: "pending", success: "success", failure: "failure", skipped: "error", cancelled: "error" };
  if (!states[outcome]) throw new Error(`Unknown verification outcome: ${outcome}`);
  if (!context || !detail) throw new Error("Status context and description are required");
  return {
    state: states[outcome],
    context,
    description: detail.slice(0, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  };
}

async function failureDetail(env) {
  const fallback = env.STATUS_FAILURE_DESCRIPTION || "verification failed";
  if (!env.STATUS_LOG_FILE) return fallback;
  let log;
  try { log = await readFile(env.STATUS_LOG_FILE, "utf8"); } catch { return fallback; }
  const lines = log.split(/\r?\n/).map((line) => line.replace(/\u001B\[[0-9;]*m/g, "").trim()).filter(Boolean);
  return lines.find((line) => /(?:^|\s)(?:src|shared|worker)\/[^\s]+\.(?:test\.)?[cm]?[jt]sx?:\d+:\d+/.test(line))
    || lines.find((line) => /FAIL|AssertionError|error TS|Error:|\berror:|failed|×|✗/i.test(line))
    || lines.at(-1) || fallback;
}

export async function publishCommitStatus(env = process.env, fetchImpl = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_SHA: sha, STAGE_OUTCOME: outcome, STATUS_CONTEXT: context } = env;
  if (!token || !repository || !sha || !outcome || !context) {
    throw new Error("Commit-status publication is missing required GitHub Actions context");
  }
  const descriptions = {
    pending: env.STATUS_PENDING_DESCRIPTION || "verification pending",
    success: env.STATUS_SUCCESS_DESCRIPTION || "verification passed",
    skipped: env.STATUS_SKIPPED_DESCRIPTION || "verification was not run because an earlier step failed",
    cancelled: "verification was cancelled",
  };
  const detail = descriptions[outcome] || await failureDetail(env);
  const targetUrl = env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
  const body = commitStatusBody({ outcome, context, detail, targetUrl });
  const url = `https://api.github.com/repos/${repository}/statuses/${sha}`;
  const transient = new Set([408, 425, 429, 500, 502, 503, 504]);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "sample-fabrication-workflow-status-reporter",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      if (attempt === 4) throw new Error(`Commit-status publication failed: ${errorMessage(error)}`, { cause: error });
    }
    if (response?.ok) return;
    if (response && (!transient.has(response.status) || attempt === 4)) {
      throw new Error(`Commit-status publication failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
    await delay(attempt * 1_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await publishCommitStatus();
}
