import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import type { FileJobStatus } from "../shared/contracts/file-jobs";
import { FabubloxImporter } from "./components/FabubloxImporter";
import { MetrologyTemplateForm } from "./components/MetrologyTemplateForm";
import { api, type TemplateDetail } from "./lib/api";
import { FileMigrationsPage } from "./pages/FileMigrationsPage";
import { MetrologyTemplatePage } from "./pages/MetrologyTemplatePage";

const at = "2026-10-08T10:00:00.000Z";
const base = "/api/files/migrations";
const intentKey = "file-migration-acceptance";
const pending = { requestId: "original-request", fileIds: ["file:1"], target: { profileId: "destination", configurationRevision: 4 } };
const settings = (): CurrentStorageSettingsStatus => ({
  version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "pending_bootstrap", policyRevision: null, internal: null, originals: null },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [], hasMore: false, limit: 100 },
});
const executor = { enabled: false, stale: false, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000, lastHeartbeatAt: null };
const job = (): FileJobStatus => ({ id: "job:1", actor: "admin@example.test", state: "paused", target: pending.target,
  acceptedAt: at, updatedAt: at, reason: "operator_paused", moved: 0, remaining: 1, failed: 0, cleanupPending: 0 });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const network = vi.fn<typeof fetch>();
function fallback(path: RequestInfo | URL): Response {
  const url = String(path);
  if (url === "/api/storage/configuration/capability") return json({ canManage: true, credentialEditingAvailable: true });
  if (url === "/api/settings/storage?version=3") return json(settings());
  if (url === `${base}/files`) return json({ items: [], nextCursor: null });
  if (url === base) return json({ jobs: [] });
  if (url === `${base}/executor`) return json(executor);
  throw new Error(`Unexpected request: ${url}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function expectReadOnlyRequests() {
  expect(network.mock.calls.length).toBeGreaterThan(0);
  expect(network.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
}
function expectNoUnqualifiedEmptyClaims() {
  expect(screen.queryByText("No writable destination is available. Activate and bind a storage profile in Storage settings.")).toBeNull();
  expect(screen.queryByText("No published Files are available for migration.")).toBeNull();
  expect(screen.queryByText("No migrations have been accepted.")).toBeNull();
}
function metrology(id: string): TemplateDetail {
  return {
    id, recipeFamilyId: `family-${id}`, name: `Metrology ${id}`, templateKind: "metrology", templateType: "module",
    version: 1, manifestHash: `manifest-${id}`, sourceFilename: null, initialStateHash: null,
    initialStateImageKeys: [], initialSubstrateStep: null, locked: false, lockedAt: null,
    createdAt: at, archived: false, metrologyNotes: `Notes ${id}`, referenceAttachments: [],
    steps: [{ id: `step-${id}`, logicalStepKey: `step-${id}`, definitionHash: `definition-${id}`,
      expectedStateHash: null, position: 0, sourceRow: null, stepNumber: null, sectionName: null,
      name: `Step ${id}`, toolName: `Tool ${id}`, parametersText: `Parameters ${id}`, commentsText: `Comments ${id}`, imageKeys: [] }],
  };
}
const routers: ReturnType<typeof createMemoryRouter>[] = [];
function openMetrology(id = "A") {
  const router = createMemoryRouter([
    { path: "/templates/metrology/:templateId", element: <MetrologyTemplatePage /> },
    { path: "/templates/:templateId", element: <p>Process destination</p> },
    { path: "/templates", element: <p>Template directory</p> },
  ], { initialEntries: [`/templates/metrology/${id}`] });
  routers.push(router);
  return { router, ...render(<RouterProvider router={router} />) };
}
beforeEach(() => {
  sessionStorage.clear();
  network.mockReset(); network.mockImplementation(async path => fallback(path)); vi.stubGlobal("fetch", network);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => {
  cleanup(); routers.splice(0).forEach(router => router.dispose());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear();
});

describe("Phase 5E advanced record reads", () => {
  it("keeps capability checking distinct from confirmed administrator denial", async () => {
    const access = deferred<Response>();
    network.mockReturnValueOnce(access.promise);
    render(<FileMigrationsPage />);
    expect(screen.getByRole("status").textContent).toBe("Reading administrator access…");
    expect(screen.queryByText("System administrator access is required to manage File migrations.")).toBeNull();
    expect(network).toHaveBeenCalledOnce();
    await act(async () => access.resolve(json({ canManage: false, credentialEditingAvailable: false })));
    await screen.findByText("System administrator access is required to manage File migrations.");
    expect(network).toHaveBeenCalledOnce(); expect(screen.queryByRole("combobox")).toBeNull(); expectReadOnlyRequests();
  });

  it("retries an unavailable capability with GETs and retains the original acceptance intent", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    network.mockResolvedValueOnce(json({ error: "private-provider-detail" }, 503));
    render(<FileMigrationsPage />);
    await screen.findByRole("alert");
    expect(screen.queryByText("System administrator access is required to manage File migrations.")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.body.textContent).not.toContain("private-provider-detail");
    fireEvent.click(screen.getByRole("button", { name: "Retry administrator access" }));
    await screen.findByText("No migrations have been accepted.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
    expect(screen.getByRole("button", { name: "Check or retry accepted request" })).toBeTruthy(); expectReadOnlyRequests();
  });

  it.each(["/api/settings/storage?version=3", `${base}/files`])("does not announce empty migration metadata after %s fails", async failedPath => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    let fail = true;
    network.mockImplementation(async path => String(path) === failedPath && fail ? json({ error: "private-detail" }, 503) : fallback(path));
    render(<FileMigrationsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Migration metadata is unavailable"); expectNoUnqualifiedEmptyClaims();
    expect(network.mock.calls.some(([path]) => String(path) === base)).toBe(false);
    fail = false; fireEvent.click(screen.getByRole("button", { name: "Retry migration metadata" }));
    await screen.findByText("No migrations have been accepted.");
    expect(screen.getByText("No published Files are available for migration.")).toBeTruthy();
    expect(screen.getByText("No writable destination is available. Activate and bind a storage profile in Storage settings.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending); expectReadOnlyRequests();
  });

  it("announces each pending read and waits for authoritative metadata before empty claims", async () => {
    const files = deferred<Response>(), jobs = deferred<Response>();
    network.mockImplementation(path => String(path) === `${base}/files` ? files.promise : String(path) === base ? jobs.promise : Promise.resolve(fallback(path)));
    render(<FileMigrationsPage />);
    await screen.findByText("Reading storage profiles and File inventory…"); expectNoUnqualifiedEmptyClaims();
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    await act(async () => files.resolve(json({ items: [], nextCursor: null })));
    await screen.findByText("Reading saved migrations and executor status…");
    expect(screen.getByText("No published Files are available for migration.")).toBeTruthy();
    expect(screen.queryByText("No migrations have been accepted.")).toBeNull();
    await act(async () => jobs.resolve(json({ jobs: [] })));
    await screen.findByText("No migrations have been accepted."); expectReadOnlyRequests();
  });

  it.each([base, `${base}/executor`])("keeps failed %s reads distinct from an empty saved-job list", async failedPath => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    let fail = true;
    network.mockImplementation(async path => String(path) === failedPath && fail ? json({ error: "private-job-detail" }, 503) : fallback(path));
    render(<FileMigrationsPage />);
    const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain("Saved migrations are unavailable");
    expect(screen.queryByText("No migrations have been accepted.")).toBeNull();
    expect(screen.getByText("Executor status is unavailable. Refresh saved jobs to read its current status.")).toBeTruthy();
    const before = network.mock.calls.length;
    fail = false; fireEvent.click(screen.getByRole("button", { name: "Retry saved migrations" }));
    await screen.findByText("No migrations have been accepted.");
    expect(network.mock.calls.slice(before).map(([path]) => String(path)).sort()).toEqual([base, `${base}/executor`].sort());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending); expectReadOnlyRequests();
  });

  it("retains saved jobs after a failed refresh without replaying pending acceptance", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    let failJobs = false;
    network.mockImplementation(async path => String(path) === base ? failJobs ? json({}, 503) : json({ jobs: [job()] }) : fallback(path));
    render(<FileMigrationsPage />); await screen.findByRole("button", { name: "Resume job" });
    failJobs = true; fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("alert");
    expect(screen.getAllByRole("heading", { name: "job:1" })).toHaveLength(1);
    expect(screen.getByText("Previously read jobs remain listed below; their status has not been refreshed.")).toBeTruthy();
    expect(screen.queryByText("No migrations have been accepted.")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
    failJobs = false; fireEvent.click(screen.getByRole("button", { name: "Retry saved migrations" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getAllByRole("heading", { name: "job:1" })).toHaveLength(1); expectReadOnlyRequests();
  });

  it("keeps an unknown acceptance warning through saved-job GET failure and recovery", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    let failJobs = false;
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") throw new Error("Lost original acceptance response");
      return String(path) === base && failJobs ? json({}, 503) : fallback(path);
    });
    render(<FileMigrationsPage />); await screen.findByText("No migrations have been accepted.");
    fireEvent.click(screen.getByRole("button", { name: "Check or retry accepted request" }));
    const warning = "File migration request is unavailable. Try again using the original request.";
    await screen.findByText(warning);
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    const writes = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes()).toHaveLength(1); expect(JSON.parse(String(writes()[0][1]?.body))).toEqual(pending);
    failJobs = true; fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Saved migrations are unavailable");
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    expect(screen.queryByText("No migrations have been accepted.")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
    failJobs = false; const before = network.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry saved migrations" }));
    await screen.findByText("No migrations have been accepted.");
    expect(screen.queryByText("Saved migrations are unavailable")).toBeNull();
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(network.mock.calls.slice(before).map(([path]) => String(path)).sort()).toEqual([base, `${base}/executor`].sort());
    expect(writes()).toHaveLength(1); expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
  });

  it("keeps an unknown acceptance warning through a failed metadata-only Refresh", async () => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    let failMetadata = false;
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") throw new Error("Lost original acceptance response");
      return String(path) === "/api/settings/storage?version=3" && failMetadata ? json({}, 503) : fallback(path);
    });
    render(<FileMigrationsPage />); await screen.findByText("No migrations have been accepted.");
    fireEvent.click(screen.getByRole("button", { name: "Check or retry accepted request" }));
    const warning = "File migration request is unavailable. Try again using the original request.";
    await screen.findByText(warning);
    failMetadata = true; fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Migration metadata is unavailable");
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
    failMetadata = false; fireEvent.click(screen.getByRole("button", { name: "Retry migration metadata" }));
    await waitFor(() => expect(screen.queryByText("Migration metadata is unavailable")).toBeNull());
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    expect(network.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
  });

  it("keeps an unconfirmed acceptance warning through item-detail GET polling failure and recovery", async () => {
    vi.useFakeTimers(); sessionStorage.setItem(intentKey, JSON.stringify(pending));
    let failDetails = false;
    const detailPath = `${base}/job%3A1/items`;
    network.mockImplementation(async (path, options) => {
      if (String(path) === base && options?.method === "POST") return json({}, 409);
      if (String(path) === base) return json({ jobs: [job()] });
      if (String(path) === detailPath) return failDetails ? json({}, 503) : json({ items: [], hasMore: false });
      return fallback(path);
    });
    await act(async () => { render(<FileMigrationsPage />); for (let i = 0; i < 40; i++) await Promise.resolve(); });
    expect(screen.getByRole("heading", { name: "job:1" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "View files in job:1" }));
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check or retry accepted request" }));
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
    const warning = "The migration request could not be confirmed. Refresh its plan or retry the original accepted request.";
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    const before = network.mock.calls.length;
    failDetails = true; await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("Saved migration details could not be refreshed. Retry only reads their current status.")).toBeTruthy();
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
    failDetails = false; await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText("Saved migrations are unavailable")).toBeNull();
    expect(screen.getByText(warning).getAttribute("role")).toBe("alert");
    expect(network.mock.calls.slice(before).every(([, options]) => options?.method === "GET")).toBe(true);
    const writes = network.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(writes).toHaveLength(1); expect(JSON.parse(String(writes[0][1]?.body))).toEqual(pending);
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending);
  });

  it.each([401, 403])("hides migration controls on actual capability denial %s without reading private response bodies", async status => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    network.mockResolvedValueOnce(json({ error: "private-capability-detail" }, status));
    render(<FileMigrationsPage />);
    await screen.findByText("System administrator access is required to manage File migrations.");
    expect(screen.queryByRole("combobox")).toBeNull(); expect(screen.queryByRole("button", { name: "Retry administrator access" })).toBeNull();
    expect(network).toHaveBeenCalledOnce(); expect(document.body.textContent).not.toContain("private-capability-detail");
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending); expectReadOnlyRequests();
  });

  it.each(["/api/settings/storage?version=3", `${base}/files`])("honors administrator revocation from the %s metadata read", async deniedPath => {
    sessionStorage.setItem(intentKey, JSON.stringify(pending));
    network.mockImplementation(async path => String(path) === deniedPath ? json({ error: "private-revocation-detail" }, 403) : fallback(path));
    render(<FileMigrationsPage />);
    await screen.findByText("System administrator access is required to manage File migrations.");
    expect(screen.queryByRole("combobox")).toBeNull(); expect(screen.queryByRole("button", { name: "Check or retry accepted request" })).toBeNull();
    expect(network.mock.calls.some(([path]) => String(path) === base)).toBe(false);
    expect(document.body.textContent).not.toContain("private-revocation-detail");
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(pending); expectReadOnlyRequests();
  });

  it("retries only the same metrology detail GET while preserving reference-upload recovery", async () => {
    const key = "metrology-reference-upload-v1:A";
    const checkpoint = { version: 1, requestId: "00000000-0000-4000-8000-000000000001", templateId: "A", observedReady: false,
      filename: "original-manual.pdf", mimeType: "application/pdf", byteSize: 18, sha256: "a".repeat(64) };
    const saved = JSON.stringify(checkpoint); sessionStorage.setItem(key, saved);
    const read = vi.spyOn(api, "getTemplate").mockRejectedValueOnce(new Error("Template read failed"))
      .mockResolvedValueOnce({ template: metrology("A") });
    const save = vi.spyOn(api, "updateMetrologyTemplate"), saveNotes = vi.spyOn(api, "updateMetrologyTemplateNotes");
    const upload = vi.spyOn(api, "uploadMetrologyTemplateReference"), remove = vi.spyOn(api, "removeTemplate");
    openMetrology();
    const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain("Metrology template is unavailable");
    expect(screen.getByRole("link", { name: "Back to templates" }).getAttribute("href")).toBe("/templates");
    fireEvent.click(screen.getByRole("button", { name: "Retry metrology template" }));
    await screen.findByRole("heading", { name: "Metrology A" });
    expect(read.mock.calls.map(([id]) => id)).toEqual(["A", "A"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Reselect original-manual.pdf to check the previous upload, or discard it to start another.")).toBeTruthy();
    expect(sessionStorage.getItem(key)).toBe(saved);
    for (const mutation of [save, saveNotes, upload, remove]) expect(mutation).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });

  it("ignores a late metrology retry result after a different source opens", async () => {
    const retry = deferred<{ template: TemplateDetail }>();
    const reads = vi.spyOn(api, "getTemplate").mockRejectedValueOnce(new Error("A unavailable")).mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce({ template: metrology("B") });
    const { router } = openMetrology(); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry metrology template" }));
    expect(screen.getByRole("status").textContent).toBe("Loading metrology template…");
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Metrology B" });
    await act(async () => retry.resolve({ template: { ...metrology("A"), templateKind: "process" } }));
    expect(router.state.location.pathname).toBe("/templates/metrology/B");
    expect(screen.getByRole("heading", { name: "Metrology B" })).toBeTruthy(); expect(screen.queryByText("Process destination")).toBeNull();
    expect(reads.mock.calls.map(([id]) => id)).toEqual(["A", "A", "B"]);
  });

  it("ignores a late metrology retry error after a different source opens", async () => {
    const retry = deferred<{ template: TemplateDetail }>();
    vi.spyOn(api, "getTemplate").mockRejectedValueOnce(new Error("A unavailable")).mockReturnValueOnce(retry.promise)
      .mockResolvedValueOnce({ template: metrology("B") });
    const { router } = openMetrology(); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry metrology template" }));
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Metrology B" });
    await act(async () => retry.reject(new Error("Old A read failed")));
    expect(screen.queryByRole("alert")).toBeNull(); expect(document.body.textContent).not.toContain("Old A read failed");
  });

  it("holds metrology fields while saving and retains the submitted draft after failure", async () => {
    const saved = deferred<void>(), submit = vi.fn(() => saved.promise), cancel = vi.fn();
    const draft = { name: "My metrology", toolName: "Tool", parametersText: "Settings", commentsText: "Notes" };
    render(<MetrologyTemplateForm title="Edit metrology" submitLabel="Save changes" initialValue={draft} onSubmit={submit} onCancel={cancel} autoFocusTitle={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith(draft);
    const fields = screen.getAllByRole("textbox") as (HTMLInputElement | HTMLTextAreaElement)[];
    expect(fields.map(field => field.value)).toEqual(Object.values(draft)); expect(fields.every(field => field.disabled)).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => saved.reject(new Error("Save unavailable")));
    expect(screen.getByRole("alert").textContent).toBe("Save unavailable");
    expect(fields.map(field => field.value)).toEqual(Object.values(draft)); expect(fields.every(field => !field.disabled)).toBe(true);
    expect(submit).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled();
  });

  it("announces a FabuBlox family-read failure as an alert without accepting an import", async () => {
    const read = vi.spyOn(api, "listTemplateFamilyOptions").mockRejectedValue(new Error("Family read unavailable"));
    const onImported = vi.fn(); render(<FabubloxImporter onImported={onImported} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Existing process templates could not be loaded: Family read unavailable");
    expect(read).toHaveBeenCalledOnce(); expect(onImported).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    expect(within(document.body).queryByRole("button", { name: "Retry original import" })).toBeNull();
  });
});
