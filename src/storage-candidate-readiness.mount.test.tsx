import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageCandidate, StorageConfigurationStatus } from "../shared/contracts/storage-configuration";
import type { StorageCandidateCheck } from "../shared/contracts/storage-candidate-check";
import type { StorageCandidateReadiness as Readiness } from "../shared/contracts/storage-candidate-readiness";
import { StorageConfigurationPage } from "./pages/StorageConfigurationPage";
import { StorageCandidateReadiness } from "./pages/StorageCandidateReadiness";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const profileId = "candidate-example", checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63";
const candidate = (): StorageCandidate => ({ profileId, revision: 2, label: "Research archive",
  namespace: { kind: "s3", endpoint: "https://objects.example.org", bucket: "research-files", region: "us-east-1", root: "work", forcePathStyle: true },
  credentials: { status: "configured", ref: "opaque-current" }, createdAt: "2026-10-02T10:00:00.000Z", createdBy: "admin@example.org" });
const configuration = (item = candidate()): StorageConfigurationStatus => ({ scope: "system", credentialEditingAvailable: true, candidates: { items: [item], hasMore: false } });
const check = (): StorageCandidateCheck => ({ id: checkId, profileId, revision: 2, status: "failed", write: "passed", read: "passed", metadata: "passed",
  delete: "failed", cleanup: "required", code: "cleanup_unconfirmed", createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:00:01.000Z", completedAt: "2026-10-02T08:00:01.000Z" });
const readiness = (): Readiness => ({ profileId, revision: 2, observedAt: "2026-10-02T10:00:00.000Z",
  credential: { envelopeRevision: 1, status: "needs_reenvelope" }, evidence: { currentConfigurationSuccessCount: 3,
    historicalConfigurationSuccessCount: 58, exactCurrentContextSuccess: { checkId, completedAt: "2026-10-02T08:00:01.000Z" },
    inProgressCount: 0, unresolvedCleanupCount: 51 }, canActivate: false });
const positive = "Recorded success matches the current configuration and stored credential version.";
const negative = "No recorded success matches the current configuration and stored credential version.";
const network = vi.fn<typeof fetch>();
function fallback(path: RequestInfo | URL) {
  const url = String(path);
  if (url.endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
  if (url.includes("/readiness?")) return json(readiness());
  if (url.includes("/checks?")) return json({ items: [check()], hasMore: false });
  if (url.includes("/checks/")) return json(check());
  if (url.includes("/credential-envelopes?")) return json({ items: [{ profileId, revision: 2, credentialRef: "opaque-current",
    envelopeRevision: 1, isCurrentCandidate: true, status: "needs_reenvelope" }], hasMore: false });
  if (url.includes("/credential-reenvelopes/")) return json({}, 503);
  return json(configuration());
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.stubGlobal("fetch", network); network.mockReset(); network.mockImplementation(async path => fallback(path)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });
const evidenceCalls = () => network.mock.calls.filter(([path]) => String(path).includes("/readiness?"));
async function openEvidence() {
  await screen.findByRole("button", { name: "Check test status for Research archive" });
  fireEvent.click(screen.getByRole("button", { name: "Check evidence for Research archive" }));
  return screen.findByRole("region", { name: "Check evidence for Research archive" });
}
async function enabledButton(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button;
}

describe("read-only candidate check evidence", () => {
  it("loads only when opened and distinguishes current context from all-history counts", async () => {
    render(<StorageConfigurationPage />); await screen.findByText("Research archive");
    expect(evidenceCalls()).toHaveLength(0);
    const panel = await openEvidence(); await within(panel).findByText(positive);
    expect(within(panel).getByText("Credentials readable; encryption update available")).toBeTruthy();
    expect(within(panel).getByText("58")).toBeTruthy(); expect(within(panel).getByText("51")).toBeTruthy();
    expect(within(panel).getByText(/Counts include all recorded history/)).toBeTruthy();
    expect(within(panel).getByText(/does not guarantee that the provider is reachable now/)).toBeTruthy();
    expect(within(panel).getByText(/Register a tested profile, activate it/)).toBeTruthy();
    expect(screen.getByText("Current configuration revision 2")).toBeTruthy();
    expect(document.body.textContent).not.toContain("opaque-current"); expect(document.body.textContent).not.toContain("admin@example.org");
    expect(network.mock.calls.every(([path, options]) => String(path).startsWith("/api/storage/configuration") && options?.method === "GET")).toBe(true);
  });

  it("does not promote same-configuration historical success to current credential evidence", async () => {
    const value = readiness(); value.credential = { envelopeRevision: 2, status: "current" }; value.evidence.exactCurrentContextSuccess = null;
    network.mockImplementation(async path => String(path).includes("/readiness?") ? json(value) : fallback(path));
    render(<StorageConfigurationPage />); const panel = await openEvidence(); await within(panel).findByText(negative);
    expect(within(panel).queryByText(positive)).toBeNull(); expect(within(panel).getByText("3")).toBeTruthy();
    expect(within(panel).getByText("Credentials readable; current encryption")).toBeTruthy();
  });

  it("shows an unavailable credential alongside exact historical evidence without claiming readiness", async () => {
    const value = readiness(); value.credential.status = "unavailable";
    network.mockImplementation(async path => String(path).includes("/readiness?") ? json(value) : fallback(path));
    render(<StorageConfigurationPage />); const panel = await openEvidence(); await within(panel).findByText(positive);
    expect(within(panel).getByText("Credentials unavailable")).toBeTruthy();
    expect(within(panel).getByText(/Register a tested profile, activate it/)).toBeTruthy();
  });

  it("fails closed for incomplete responses and renders no server diagnostic details", async () => {
    const { credential: _missing, ...value } = readiness();
    network.mockImplementation(async path => String(path).includes("/readiness?") ? json({ ...value, privateDetail: "private-key-data" }) : fallback(path));
    render(<StorageConfigurationPage />); await openEvidence();
    await screen.findByText("Check evidence is unavailable. Refresh evidence to try again.");
    expect(screen.queryByText(positive)).toBeNull(); expect(document.body.textContent).not.toContain("private-key-data");
  });

  it("aborts an invalidated read and ignores a late positive result even when transport ignores abort", async () => {
    const pending = deferred<Response>(); network.mockReturnValueOnce(pending.promise);
    const props = { candidate: candidate(), evidenceGeneration: 0, blocked: false, onForbidden: vi.fn() };
    const mounted = render(<StorageCandidateReadiness {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Check evidence for Research archive" }));
    await waitFor(() => expect(network).toHaveBeenCalledOnce()); const signal = network.mock.calls[0][1]?.signal;
    mounted.rerender(<StorageCandidateReadiness {...props} evidenceGeneration={1} blocked />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(json(readiness())); }); expect(screen.queryByText(positive)).toBeNull();
    mounted.rerender(<StorageCandidateReadiness {...props} evidenceGeneration={1} />);
    expect(screen.queryByText(positive)).toBeNull(); expect(network).toHaveBeenCalledOnce();
    const next = readiness(); next.evidence.exactCurrentContextSuccess = null; network.mockResolvedValueOnce(json(next));
    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" })); await screen.findByText(negative);
  });

  it("drops old revision evidence immediately and rejects a late response from that revision", async () => {
    const pending = deferred<Response>(); network.mockReturnValueOnce(pending.promise);
    const props = { candidate: candidate(), evidenceGeneration: 0, blocked: false, onForbidden: vi.fn() };
    const mounted = render(<StorageCandidateReadiness {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Check evidence for Research archive" }));
    const next = readiness(); next.revision = 3; next.evidence.exactCurrentContextSuccess = null;
    network.mockResolvedValueOnce(json(next));
    mounted.rerender(<StorageCandidateReadiness {...props} candidate={{ ...candidate(), revision: 3 }} />);
    await screen.findByText(negative); await act(async () => { pending.resolve(json(readiness())); });
    expect(screen.queryByText(positive)).toBeNull(); expect(screen.getByText(negative)).toBeTruthy();
  });

  it("revokes administrator UI when an evidence read returns forbidden", async () => {
    network.mockImplementation(async path => String(path).includes("/readiness?") ? json({ error: "private-admin-policy" }, 403) : fallback(path));
    render(<StorageConfigurationPage />); await openEvidence(); await screen.findByRole("heading", { name: "Read only" });
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull(); expect(screen.queryByText("Research archive")).toBeNull();
    expect(document.body.textContent).not.toContain("private-admin-policy");
  });

  for (const operation of ["test", "cleanup", "encryption", "save"] as const) {
    it(`clears positive evidence at ${operation} attempt start and keeps it cleared after a failed or uncertain response`, async () => {
      const pending = deferred<Response>();
      network.mockImplementation(async (path, options) => options?.method === "POST" || options?.method === "PUT" ? pending.promise : fallback(path));
      render(<StorageConfigurationPage />);
      if (operation === "encryption") {
        fireEvent.click(await screen.findByRole("button", { name: "Credential encryption for Research archive" }));
        await enabledButton("Update encryption for revision 2");
      }
      if (operation === "save") fireEvent.click(await screen.findByRole("button", { name: "Edit Research archive" }));
      await openEvidence(); await screen.findByText(positive);
      const name = { test: "Test Research archive", cleanup: "Clean up test object for revision 2", encryption: "Update encryption for revision 2", save: "Save draft" }[operation];
      fireEvent.click(await enabledButton(name));
      expect(screen.queryByText(positive)).toBeNull(); expect((screen.getByRole("button", { name: "Refresh evidence" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { pending.resolve(json({ error: "private-operation-detail" }, operation === "test" ? 400 : 503)); });
      await waitFor(() => expect(document.body.textContent).not.toContain(operation === "encryption" ? "Updating encryption…" : "Saving…"));
      expect(screen.queryByText(positive)).toBeNull(); expect(evidenceCalls()).toHaveLength(1);
      expect(document.body.textContent).not.toContain("private-operation-detail");
    });
  }

  it("clears evidence when refreshing test history or encryption metadata", async () => {
    render(<StorageConfigurationPage />); await openEvidence(); await screen.findByText(positive);
    fireEvent.click(screen.getByRole("button", { name: "Check test status for Research archive" }));
    expect(screen.queryByText(positive)).toBeNull(); await enabledButton("Refresh evidence");
    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" })); await screen.findByText(positive);
    fireEvent.click(screen.getByRole("button", { name: "Credential encryption for Research archive" }));
    expect(screen.queryByText(positive)).toBeNull(); await enabledButton("Refresh evidence");
    expect(evidenceCalls()).toHaveLength(2);
  });

  it("invalidates evidence when automatic polling reconciles a recorded running test", async () => {
    const running: StorageCandidateCheck = { ...check(), status: "running", read: "pending", metadata: "pending", delete: "pending", cleanup: "pending", completedAt: null };
    network.mockImplementation(async path => String(path).includes("/checks?") ? json({ items: [running], hasMore: false }) : fallback(path));
    vi.useFakeTimers(); render(<StorageConfigurationPage />);
    await vi.waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Check evidence for Research archive" }));
    await vi.waitFor(() => expect(screen.getByText(positive)).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByText(positive)).toBeNull(); expect(screen.getByText("Failed", { selector: "strong" })).toBeTruthy();
    expect(evidenceCalls()).toHaveLength(1);
  });

  it("requires a fresh observation of the new revision after saving a candidate", async () => {
    let revision = 2;
    const updatedHistory = deferred<Response>(), updatedEvidence = deferred<Readiness>();
    network.mockImplementation(async (path, options) => {
      if (options?.method === "PUT") { revision = 3; return json({}); }
      if (String(path).includes("/checks?") && revision === 3) return updatedHistory.promise;
      if (String(path).includes("/readiness?")) {
        return revision === 3 ? updatedEvidence.promise.then(value => json(value)) : json(readiness());
      }
      if (String(path) === "/api/storage/configuration") return json(configuration({ ...candidate(), revision }));
      return fallback(path);
    });
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Edit Research archive" }));
    await openEvidence(); await screen.findByText(positive);
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Historical revision 2"); expect(screen.queryByText(positive)).toBeNull();
    // The revision label renders before its automatic history read settles.
    // That read invalidates evidence, so observe its completion before starting
    // the deliberate fresh observation of the newly saved revision.
    await waitFor(() => expect(network.mock.calls.filter(([path]) => String(path).includes("/checks?"))).toHaveLength(2));
    await screen.findByText("Evidence cleared while configuration or test work is unresolved. Refresh evidence when it settles.");
    expect((screen.getByRole("button", { name: "Refresh evidence" }) as HTMLButtonElement).disabled).toBe(true);
    expect(evidenceCalls().filter(([path]) => String(path).includes("expectedRevision=3"))
      .every(([, options]) => options?.signal?.aborted)).toBe(true);
    await act(async () => { updatedHistory.resolve(json({ items: [check()], hasMore: false })); });
    await waitFor(() => expect(screen.queryByText("Reading test history…")).toBeNull());
    const priorObservations = evidenceCalls().length;
    fireEvent.click(await enabledButton("Refresh evidence"));
    await waitFor(() => expect(evidenceCalls()).toHaveLength(priorObservations + 1));
    await waitFor(() => expect(evidenceCalls().at(-1)?.[0]).toBe("/api/storage/configuration/readiness?profileId=candidate-example&expectedRevision=3"));
    const current = readiness(); current.revision = 3; current.evidence.exactCurrentContextSuccess = null;
    await act(async () => { updatedEvidence.resolve(current); });
    await screen.findByText(negative); expect(screen.queryByText(positive)).toBeNull();
    expect(evidenceCalls().at(-1)?.[0]).toBe("/api/storage/configuration/readiness?profileId=candidate-example&expectedRevision=3");
  });

  it("refreshes to historical-only evidence after a successful credential encryption update", async () => {
    let updated = false;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") {
        const input = JSON.parse(String(options.body)); updated = true;
        return json({ operationId: input.operationId, profileId, revision: 2, credentialRef: "opaque-current", previousEnvelopeRevision: 1,
          envelopeRevision: 2, outcome: "reenveloped", createdAt: "2026-10-02T10:01:00.000Z", createdBy: "admin@example.org" });
      }
      if (String(path).includes("/readiness?") && updated) {
        const value = readiness(); value.credential = { envelopeRevision: 2, status: "current" }; value.evidence.exactCurrentContextSuccess = null; return json(value);
      }
      return fallback(path);
    });
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Credential encryption for Research archive" }));
    await enabledButton("Update encryption for revision 2"); await openEvidence(); await screen.findByText(positive);
    fireEvent.click(screen.getByRole("button", { name: "Update encryption for revision 2" }));
    await screen.findByText("Credential encryption updated for revision 2."); expect(screen.queryByText(positive)).toBeNull();
    fireEvent.click(await enabledButton("Refresh evidence")); await screen.findByText(negative);
    expect(screen.getByText("Credentials readable; current encryption")).toBeTruthy();
  });
});
