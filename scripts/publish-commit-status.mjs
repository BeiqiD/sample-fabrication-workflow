import { readFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA;
const outcome = process.env.STAGE_OUTCOME;
const baseContext = process.env.STATUS_CONTEXT;
const successDescription = process.env.STATUS_SUCCESS_DESCRIPTION;
const fallbackFailure = process.env.STATUS_FAILURE_DESCRIPTION || "verification failed";
const logFile = process.env.STATUS_LOG_FILE;
const dynamicFailureContext = process.env.STATUS_DYNAMIC_FAILURE_CONTEXT === "1";

if (!token || !repository || !sha || !outcome || !baseContext || !successDescription) {
  throw new Error("Commit-status publication is missing required GitHub Actions context");
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

async function failureDetail() {
  if (!logFile) return fallbackFailure;
  let log = "";
  try {
    log = await readFile(logFile, "utf8");
  } catch {
    return fallbackFailure;
  }
  const lines = log
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
  if (dynamicFailureContext) {
    const location = lines.find((line) => (
      /(?:^|\s)(?:src|shared|worker)\/[^\s]+\.(?:test\.)?[cm]?[jt]sx?:\d+:\d+/.test(line)
    ));
    if (location) return location;
  }
  return lines.find((line) => (
    /FAIL|AssertionError|error TS|Error:|\berror:|failed|×|✗/i.test(line)
  )) || lines.at(-1) || fallbackFailure;
}

const detail = outcome === "success" ? successDescription : await failureDetail();
const slug = detail
  .replace(/[^A-Za-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 72) || "failure";
const context = outcome === "success" || !dynamicFailureContext
  ? baseContext
  : `${baseContext}/${slug}`;
const body = {
  state: outcome === "success" ? "success" : "failure",
  context,
  description: detail.slice(0, 140),
};
const [owner, repo] = repository.split("/");
const url = `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`;
const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const requestTimeoutMs = 8_000;

class PermanentStatusPublicationError extends Error {}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

for (let attempt = 1; attempt <= 4; attempt += 1) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "sample-fabrication-workflow-status-reporter",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.ok) process.exit(0);

    const responseBody = await response.text();
    if (!transientStatuses.has(response.status)) {
      throw new PermanentStatusPublicationError(
        `GitHub commit-status publication failed (${response.status}): ${responseBody.slice(0, 500)}`,
      );
    }
    if (attempt === 4) {
      throw new Error(
        `GitHub commit-status publication remained transiently unavailable (${response.status}): ${responseBody.slice(0, 500)}`,
      );
    }
  } catch (error) {
    if (error instanceof PermanentStatusPublicationError) throw error;
    if (attempt === 4) {
      throw new Error(
        `GitHub commit-status publication failed after ${attempt} attempts: ${errorMessage(error)}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }
  await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
}
