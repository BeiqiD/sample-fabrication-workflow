from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    target.write_text(text.replace(old, new, 1))


# Client errors carry an explicit disposition only when the Project route itself
# proves an authoritative mutation rejection. Middleware 401/403/404 responses
# intentionally remain unmarked.
replace_once(
    "src/lib/project-client.ts",
    '''export class ProjectApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
  }
}

async function projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
    };
    throw new ProjectApiError(
      payload.error || `Project request failed (${response.status})`,
      response.status,
    );
  }
''',
    '''export type ProjectMutationDisposition = "authoritative-rejection";

export class ProjectApiError extends Error {
  readonly status: number;
  readonly mutationDisposition: ProjectMutationDisposition | null;

  constructor(
    message: string,
    status: number,
    mutationDisposition: ProjectMutationDisposition | null = null,
  ) {
    super(message);
    this.name = "ProjectApiError";
    this.status = status;
    this.mutationDisposition = mutationDisposition;
  }
}

async function projectRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      projectMutationDisposition?: unknown;
    };
    const mutationDisposition = payload.projectMutationDisposition === "authoritative-rejection"
      ? payload.projectMutationDisposition
      : null;
    throw new ProjectApiError(
      payload.error || `Project request failed (${response.status})`,
      response.status,
      mutationDisposition,
    );
  }
''',
)

# Initial request certainty and uncertain-replay settlement are different
# questions. A later 4xx is not settlement proof unless the mutation route marks
# it as having crossed the authoritative Project boundary.
certainty_block = '''export function projectCanvasPasteFailureCertainty(
  error: unknown,
): ProjectCanvasPasteFailureCertainty {
  if (!(error instanceof ProjectApiError)) return "uncertain";
  return error.status === 408
    || error.status === 425
    || error.status === 429
    || error.status >= 500
    ? "uncertain"
    : "deterministic";
}
'''
replace_once(
    "src/lib/use-project-canvas-copy-paste.ts",
    certainty_block,
    certainty_block + '''\nexport function projectCanvasPasteReplayIsAuthoritativelySettled(error: unknown) {
  return error instanceof ProjectApiError
    && error.mutationDisposition === "authoritative-rejection";
}
''',
)
replace_once(
    "src/lib/use-project-canvas-copy-paste.ts",
    '''      const certainty = projectCanvasPasteFailureCertainty(error);
      if (certainty === "deterministic") {
        await installAuthoritative(generation, requestProjectId, current.journal, "abandon");
        return;
      }
      updatePaste({
        status: "paused",
        journal: current.journal,
        failedStep: failure,
        failureCertainty: "uncertain",
        message: `The exact replay is still outcome-uncertain. The journal and navigation protection remain active; retry before abandoning: ${pasteErrorMessage(error)}`,
      });
''',
    '''      if (projectCanvasPasteReplayIsAuthoritativelySettled(error)) {
        await installAuthoritative(generation, requestProjectId, current.journal, "abandon");
        return;
      }
      updatePaste({
        status: "paused",
        journal: current.journal,
        failedStep: failure,
        failureCertainty: "uncertain",
        message: `The exact replay did not prove an authoritative mutation settlement. The journal and navigation protection remain active; retry before abandoning: ${pasteErrorMessage(error)}`,
      });
''',
)

# Project-route 404/409 errors are emitted after the request entered the Project
# route/service boundary. Parent authentication and same-origin 403s occur before
# this nested error handler and therefore cannot forge the settlement marker.
replace_once(
    "worker/project-routes.ts",
    '''export const routes = new Hono<AppBindings>();

// Project owns complete export and persistence under one aggregate. The core
''',
    '''export const routes = new Hono<AppBindings>();

routes.onError((error, c) => {
  if (error instanceof HTTPException && (error.status === 404 || error.status === 409)) {
    return c.json({
      error: error.message,
      projectMutationDisposition: "authoritative-rejection" as const,
    }, error.status);
  }
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  throw error;
});

// Project owns complete export and persistence under one aggregate. The core
''',
)

# Verify the Worker-facing marker on an authoritative Project conflict.
replace_once(
    "worker/project-routes.test.ts",
    '''    expect(staleMove.status).toBe(409);
    expect(await staleMove.json()).toMatchObject({ error: "Placement revision conflict" });
    database.close();
''',
    '''    expect(staleMove.status).toBe(409);
    expect(await staleMove.json()).toMatchObject({
      error: "Placement revision conflict",
      projectMutationDisposition: "authoritative-rejection",
    });
    database.close();
''',
)

# Mounted regression: after an original response loss, unmarked middleware-style
# 403/404 replays must not trigger GET or clear the journal. Only an explicitly
# marked authoritative rejection may settle that uncertain step.
mounted_anchor = '''  it("does not replay a deterministically rejected write before authoritative abandon reload", async () => {
'''
mounted_test = '''  it("keeps uncertain abandonment blocked across unmarked 403/404 replays until authoritative settlement", async () => {
    let authoritative = pasteSnapshot();
    let getAttempts = 0;
    let referenceAttempts = 0;
    let edgeAttempts = 0;

    fetchMock.mockImplementation((request, init) => {
      const path = String(request);
      if (!init?.method || init.method === "GET") {
        getAttempts += 1;
        return jsonResponse(authoritative);
      }
      if (init.method !== "POST") throw new Error(`Unexpected ${init.method} ${path}`);
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      if (path.endsWith("/items/markdown")) {
        const created = createProjectItemResponse(authoritative, path, body);
        authoritative = created.next;
        return jsonResponse(created.result, 201);
      }
      if (path.endsWith("/items/reference")) {
        referenceAttempts += 1;
        if (referenceAttempts === 1) {
          return Promise.reject(new TypeError("simulated response loss before middleware failures"));
        }
        if (referenceAttempts === 2) {
          return jsonResponse({ error: "Authentication required" }, 403);
        }
        if (referenceAttempts === 3) {
          return jsonResponse({ error: "Project route temporarily unavailable" }, 404);
        }
        return jsonResponse({
          error: "Project revision conflict",
          projectMutationDisposition: "authoritative-rejection",
        }, 409);
      }
      if (path.endsWith("/edges")) {
        edgeAttempts += 1;
        throw new Error("The later edge step must remain unattempted while abandonment is settling");
      }
      throw new Error(`Unexpected POST ${path}`);
    });

    renderProjectPage();
    await screen.findByTestId("project-flow-canvas");
    copyAndPasteSelection();

    await screen.findByText(/Paste paused after 1\\/3 acknowledged writes/);
    expect(getAttempts).toBe(1);
    expect(referenceAttempts).toBe(1);
    expect(edgeAttempts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Reload and abandon remaining paste" }));
    await waitFor(() => expect(referenceAttempts).toBe(2));
    await screen.findByText(/exact replay did not prove an authoritative mutation settlement/i);
    expect(getAttempts).toBe(1);
    expect(edgeAttempts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Reload and abandon remaining paste" }));
    await waitFor(() => expect(referenceAttempts).toBe(3));
    await screen.findByText(/exact replay did not prove an authoritative mutation settlement/i);
    expect(getAttempts).toBe(1);
    expect(edgeAttempts).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Reload and abandon remaining paste" }));
    await screen.findByText(
      "Authoritative Project state was loaded. 1 pasted item already committed to the Project remains; the later unattempted paste steps were abandoned.",
    );
    expect(getAttempts).toBe(2);
    expect(referenceAttempts).toBe(4);
    expect(edgeAttempts).toBe(0);
  });

'''
replace_once(
    "src/project-canvas-paste-abandon.mount.test.tsx",
    mounted_anchor,
    mounted_test + mounted_anchor,
)

# Make status publication bounded even when GitHub accepts a connection but never
# returns a response, and retry transport/body-read failures as transient.
status_path = Path("scripts/publish-commit-status.mjs")
status_text = status_path.read_text()
status_tail = '''const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

for (let attempt = 1; attempt <= 4; attempt += 1) {
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
  });
  if (response.ok) process.exit(0);

  const responseBody = await response.text();
  if (!transientStatuses.has(response.status) || attempt === 4) {
    throw new Error(
      `GitHub commit-status publication failed (${response.status}): ${responseBody.slice(0, 500)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
}
'''
status_new = '''const transientStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
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
'''
if status_text.count(status_tail) != 1:
    raise SystemExit("scripts/publish-commit-status.mjs: status tail changed unexpectedly")
status_path.write_text(status_text.replace(status_tail, status_new, 1))

# A status publisher is reporting only; bound every reporting step separately so
# a future regression in the helper still cannot consume the whole verification job.
workflow_path = Path(".github/workflows/verify.yml")
workflow = workflow_path.read_text()
status_step = "        continue-on-error: true\n        env:\n          GITHUB_TOKEN:"
status_step_with_timeout = "        continue-on-error: true\n        timeout-minutes: 1\n        env:\n          GITHUB_TOKEN:"
status_count = workflow.count(status_step)
if status_count != 13:
    raise SystemExit(f"verify.yml: expected 13 status steps, found {status_count}")
workflow_path.write_text(workflow.replace(status_step, status_step_with_timeout))

# Keep the permanent CI contract aware of both timeout layers.
replace_once(
    "src/project-edges-contract.test.ts",
    '''    const workflow = fs.readFileSync(".github/workflows/verify.yml", "utf8");
''',
    '''    const workflow = fs.readFileSync(".github/workflows/verify.yml", "utf8");
    const statusPublisher = fs.readFileSync("scripts/publish-commit-status.mjs", "utf8");
''',
)
replace_once(
    "src/project-edges-contract.test.ts",
    '''    expect(workflow).toContain("scripts/publish-commit-status.mjs");
    expect(workflow).toContain("continue-on-error: true");
''',
    '''    expect(workflow).toContain("scripts/publish-commit-status.mjs");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("timeout-minutes: 1");
    expect(statusPublisher).toContain("AbortSignal.timeout(requestTimeoutMs)");
''',
)

# Align the contract with the stronger replay-settlement rule.
doc_path = Path("docs/PROJECT_CANVAS_COPY_PASTE_CONTRACT.md")
doc = doc_path.read_text()
doc = doc.replace(
    "Last reviewed: 2026-08-17 after closing the uncertain-abandon late-commit race, completing selection locking, and hardening verification status publication for PR #149",
    "Last reviewed: 2026-08-18 after requiring authoritative proof for uncertain replay settlement and bounding verification status publication for PR #149",
)
pattern = re.compile(
    r'''Failure certainty controls abandonment:\n\n- a network failure, malformed/lost success response, HTTP `408`, `425`, `429`, or `5xx` is \*\*outcome-uncertain\*\*;\n- another received HTTP `4xx` is a \*\*deterministic rejection\*\*.\n\n`Reload and abandon remaining paste` may immediately reload after a deterministic rejection because the failed request is known not to have committed\. It must not do that after an outcome-uncertain failure\. Instead, it first replays \*\*only the failed pending step\*\* using the exact frozen destination IDs, payload, expected revision, and operation ID\. It does not execute later pending items or edges\.\n\nThe uncertain step is considered settled only when that exact replay either:\n\n- acknowledges the same destination mutation or exact server replay; or\n- receives a deterministic rejection that the original exact request could no longer commit past\.\n\nOnly after settlement may the client perform the authoritative GET, retain any destination rows that actually committed, abandon the later unattempted steps, and clear the journal\. If exact replay remains outcome-uncertain, the same journal, failed-step identity, selection lock, navigation blocker, and `beforeunload` protection remain active\. A GET alone can never clear an uncertain journal because it could race an earlier request that commits after the read\.'''
)
replacement = '''Failure certainty controls abandonment. For the **request that just failed**, a network failure, malformed/lost success response, HTTP `408`, `425`, `429`, or `5xx` is outcome-uncertain; another received HTTP `4xx` is a deterministic rejection for that request.\n\nThat initial classification is deliberately **not** reused to settle an earlier outcome-uncertain write. `Reload and abandon remaining paste` first replays **only the failed pending step** using the exact frozen destination IDs, payload, expected revision, and operation ID. It does not execute later pending items or edges.\n\nThe uncertain step is considered settled only when that exact replay either:\n\n- acknowledges the same destination mutation or exact server replay; or\n- returns the machine-readable `projectMutationDisposition: "authoritative-rejection"`, which is emitted by the Project route only after the request reaches the authoritative Project mutation/service error boundary.\n\nAn unmarked replay `401`, `403`, `404`, other `4xx`, transport failure, timeout, or `5xx` does **not** settle the earlier uncertain request. In particular, authentication and same-origin middleware run before Project routes and therefore cannot manufacture the authoritative-rejection disposition. The same journal, failed-step identity, selection lock, navigation blocker, and `beforeunload` protection remain active until a later exact replay proves settlement.\n\nOnly after settlement may the client perform the authoritative GET, retain any destination rows that actually committed, abandon the later unattempted steps, and clear the journal. A GET alone can never clear an uncertain journal because it could race an earlier request that commits after the read.'''
doc, replacements = pattern.subn(replacement, doc, count=1)
if replacements != 1:
    raise SystemExit(f"copy/paste contract: expected one certainty section, found {replacements}")
doc_path.write_text(doc)

print("Applied PR #149 review fixes")
