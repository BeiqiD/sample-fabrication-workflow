import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuthentication } from "./lib/authentication-client";
import { ResearchPackagesPage } from "./pages/ResearchPackagesPage";
import { checkpointStorage } from "./lib/browser-checkpoints";
import { hashResearchFile } from "../shared/domain/research-sha256";
import { validateStoreArchive } from "../shared/domain/research-archive";

vi.mock("../shared/domain/research-sha256", () => ({ hashResearchFile: vi.fn() }));
vi.mock("../shared/domain/research-archive", async importOriginal => ({ ...await importOriginal<typeof import("../shared/domain/research-archive")>(), validateStoreArchive: vi.fn() }));

// Controlled browser transport: verifies that account changes cannot revive a
// previous actor's pending operation. Server ownership has separate coverage.
const alice = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae", bob = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a";
const requestId = "22222222-2222-4222-8222-222222222222", base = "/api/packages";
const at = "2026-10-18T00:00:00.000Z";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
let principal = alice;
const calls = (path: string, method = "GET") => network.mock.calls.filter(([url, options]) => String(url) === path && (options?.method || "GET") === method);
function mount() { return render(<MemoryRouter><ResearchPackagesPage /></MemoryRouter>); }
async function enabled(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button.matches(":disabled")).toBe(false)); return button;
}
async function signInAs(id: string) { principal = id; await readAuthentication(); }
beforeEach(() => {
  sessionStorage.clear(); principal = alice; vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
  vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId); network.mockReset(); vi.stubGlobal("fetch", network);
  vi.mocked(hashResearchFile).mockReset(); vi.mocked(validateStoreArchive).mockReset();
  network.mockImplementation(async (path, init) => {
    if (String(path) === "/api/auth/session") return json({ principal: { id: principal, actor: `local-account:${principal}`,
      capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: (principal === alice ? "A" : "B").repeat(43) });
    if (String(path) === `${base}/jobs` && init?.method === "GET") return json({ jobs: [] });
    if (String(path) === `${base}/executor`) return json({ supported: true, enabled: true, stale: false, canManage: false,
      lastHeartbeatAt: at, cadenceSeconds: 120, maxStepMs: 60000, reason: null });
    if (String(path) === `${base}/plans`) {
      const input = JSON.parse(String(init?.body));
      return json({ schema: "research-package-preview/1", kind: input.kind, roots: input.roots,
        counts: { records: 1, files: 0, bytes: 0 }, archiveBytes: 2048, metadataBytes: 512, warnings: [], complete: true,
        capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } },
        dependencies: [], source: null, rolePolicyRevision: null, naming: null, targets: [], existingImportJobId: null });
    }
    if (String(path) === `${base}/jobs` && init?.method === "POST") throw new Error("Original acknowledgement lost");
    if (String(path) === `${base}/requests/${requestId}`) return json({ schema: "research-package-request-absent/1", requestId }, 404);
    throw new Error(`Unexpected fixture request: ${String(path)}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionStorage.clear(); });

describe("local account checkpoint isolation", () => {
  it.each(["hash", "archive validation"])("never sends an accepted upload's old bytes after the account changes during %s, even before unmount", async stage => {
    await signInAs(alice);
    const input = { requestId, byteSize: 32, sha256: "a".repeat(64) }, jobId = "alice-upload";
    const original = JSON.stringify({ input, jobId }); checkpointStorage().setItem("research-package-upload", original);
    const pendingJob = { id: jobId, requestId, kind: "upload", state: "awaiting_upload", phase: "validate", acceptedAt: at, updatedAt: at, reason: "upload_required",
      progress: { completedFiles: 0, totalFiles: 0, bytesDone: 0, bytesTotal: 32 }, output: null, result: null };
    const fallback = network.getMockImplementation()!;
    network.mockImplementation(async (path, init) => {
      if (String(path) === `${base}/jobs` && init?.method === "GET") return json({ jobs: [pendingJob] });
      if (init?.method === "PUT") return json({ ...pendingJob, state: "queued" });
      return fallback(path, init);
    });
    let release!: () => void, entered = false; const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(hashResearchFile).mockImplementation(async () => { if (stage === "hash") { entered = true; await held; } return input; });
    vi.mocked(validateStoreArchive).mockImplementation(async () => {
      if (stage === "archive validation") { entered = true; await held; }
      return {} as Awaited<ReturnType<typeof validateStoreArchive>>;
    });
    mount(); await screen.findByText(/The accepted upload is waiting for bytes/);
    fireEvent.change(screen.getByLabelText("Native package ZIP"), { target: { files: [new File([new Uint8Array(32)], "original.zip", { type: "application/zip" })] } });
    fireEvent.click(await enabled("Resume original upload")); await waitFor(() => expect(entered).toBe(true));
    await act(async () => signInAs(bob)); await act(async () => release());
    expect(network.mock.calls.filter(([, init]) => ["POST", "PUT"].includes(init?.method ?? ""))).toHaveLength(0);
    expect(checkpointStorage().length).toBe(0);
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index)!))).toEqual([original]);
  });
  it("retains Alice's unknown export for Alice while Bob cannot see or retry that operation", async () => {
    await signInAs(alice);
    let page = mount(); await screen.findByText("No package jobs are recorded for your account.");
    fireEvent.change(screen.getByLabelText("Sample and Project roots"), { target: { value: "sample:alice-private-scope" } });
    fireEvent.click(await enabled("Preview export")); fireEvent.click(await enabled("Start data package export"));
    await waitFor(() => expect(calls(`${base}/jobs`, "POST")).toHaveLength(1));
    await screen.findByRole("heading", { name: "Unconfirmed operation" });
    const original = String(calls(`${base}/jobs`, "POST")[0][1]?.body);
    const retained = [...Array(sessionStorage.length)].map((_, index) => [sessionStorage.key(index)!, sessionStorage.getItem(sessionStorage.key(index)!)!] as const);
    page.unmount(); await signInAs(bob);
    page = mount(); await screen.findByText("No package jobs are recorded for your account.");
    expect(screen.queryByRole("heading", { name: "Unconfirmed operation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry original package request" })).toBeNull();
    expect(document.body.textContent).not.toContain(requestId); expect(document.body.textContent).not.toContain("alice-private-scope");
    expect(calls(`${base}/requests/${requestId}`)).toHaveLength(0);
    for (const [key, value] of retained) expect(sessionStorage.getItem(key)).toBe(value);
    page.unmount(); await signInAs(alice);
    mount(); await screen.findByRole("heading", { name: "Unconfirmed operation" });
    fireEvent.click(await enabled("Retry original package request"));
    await waitFor(() => expect(calls(`${base}/jobs`, "POST")).toHaveLength(2));
    expect(String(calls(`${base}/jobs`, "POST")[1][1]?.body)).toBe(original);
    expect(new Headers(calls(`${base}/jobs`, "POST")[1][1]?.headers).get("x-sfw-csrf")).toBe("A".repeat(43));
  });
});
