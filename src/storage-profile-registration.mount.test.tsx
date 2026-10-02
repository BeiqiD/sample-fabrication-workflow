import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageCandidate } from "../shared/contracts/storage-configuration";
import type { StorageCandidateReadiness as Readiness } from "../shared/contracts/storage-candidate-readiness";
import type { StorageProfileAdmissionInput, StorageProfileAdmissionReceipt } from "../shared/contracts/storage-profile-admission";
import { StorageProfileRegistration } from "./pages/StorageProfileRegistration";
import { StorageCandidateReadiness } from "./pages/StorageCandidateReadiness";

const checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63", operationId = "d8992768-d864-444b-8e97-e58a5d8f40b0";
const nativeProfileId = `storage-profile:aws-s3:${"a".repeat(64)}`;
const sessionKey = "storage-profile-registration:candidate-example";
const candidate = (): StorageCandidate => ({ profileId: "candidate-example", revision: 1, label: "AWS archive",
  namespace: { kind: "s3", endpoint: "https://s3.eu-west-1.amazonaws.com", region: "eu-west-1", bucket: "private-bucket", root: "files",
    forcePathStyle: true, expectedBucketOwner: "123456789012" },
  credentials: { status: "configured", ref: "private-opaque-reference" }, createdAt: "2026-10-02T10:00:00.000Z", createdBy: "admin@example.org" });
const readiness = (): Readiness => ({ profileId: "candidate-example", revision: 1, observedAt: "2026-10-02T11:00:00.000Z",
  credential: { envelopeRevision: 2, status: "current" }, evidence: { currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0,
    exactCurrentContextSuccess: { checkId, completedAt: "2026-10-02T10:00:00.000Z" }, inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
const input = (): StorageProfileAdmissionInput => ({ operationId, profileId: "candidate-example", expectedRevision: 1, expectedEnvelopeRevision: 2, checkId });
const receipt = (request = input()): StorageProfileAdmissionReceipt => ({ operationId: request.operationId, profileId: request.profileId,
  revision: request.expectedRevision, envelopeRevision: request.expectedEnvelopeRevision, checkId: request.checkId,
  nativeProfileId, configurationRevision: 1, runtimeAccess: "read_only", createdAt: "2026-10-02T11:01:00.000Z", createdBy: "private-operator@example.org" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
const props = () => ({ candidate: candidate(), evidence: readiness(), blocked: false, onForbidden: vi.fn(), onStaleEvidence: vi.fn() });
const posts = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
beforeEach(() => { vi.stubGlobal("fetch", network); network.mockReset(); network.mockResolvedValue(json({}, 404)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("read-only AWS profile registration", () => {
  it("records an exact intent before registering and describes registration without enabling file access", async () => {
    let submitted!: StorageProfileAdmissionInput;
    network.mockImplementation(async (_path, options) => {
      if (options?.method !== "POST") return json({}, 404);
      submitted = JSON.parse(String(options.body));
      expect(JSON.parse(sessionStorage.getItem(sessionKey)!)).toEqual(submitted);
      return json(receipt(submitted));
    });
    render(<StorageProfileRegistration {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Register profile" }));
    await screen.findByText(nativeProfileId);
    expect(submitted).toMatchObject({ profileId: "candidate-example", expectedRevision: 1, expectedEnvelopeRevision: 2, checkId });
    expect(posts()).toHaveLength(1); expect(posts()[0][0]).toBe("/api/storage/configuration/registrations");
    expect(screen.getByRole("status").textContent).toContain("File access is not enabled and upload destinations are unchanged.");
    expect(screen.queryByRole("button", { name: /Register profile|Activate/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/private-bucket|123456789012|private-operator|private-opaque-reference/);
    expect(network.mock.calls.every(([path]) => String(path).startsWith("/api/storage/configuration/registrations"))).toBe(true);
  });

  it("finds a previously registered physical storage after reload without needing browser state", async () => {
    network.mockResolvedValue(json({ ...receipt(), profileId: "another-candidate", revision: 7 }));
    render(<StorageProfileRegistration {...props()} />); await screen.findByText(nativeProfileId);
    expect(screen.queryByRole("button", { name: "Register profile" })).toBeNull();
    expect(document.body.textContent).not.toContain("revision 7"); expect(posts()).toHaveLength(0);
    expect(network.mock.calls[0][0]).toBe("/api/storage/configuration/registrations?profileId=candidate-example&expectedRevision=1");
  });

  for (const reason of ["generic S3", "GovCloud", "no owner", "old encryption", "no success", "unfinished cleanup", "running test", "busy configuration"] as const) {
    it(`does not offer registration for ${reason}`, async () => {
      const value = props();
      if (value.candidate.namespace.kind !== "s3") throw new Error("Expected S3 fixture");
      if (reason === "generic S3") { value.candidate.namespace.endpoint = "https://objects.example.org"; delete value.candidate.namespace.expectedBucketOwner; }
      if (reason === "GovCloud") { value.candidate.namespace.endpoint = "https://s3.us-gov-west-1.amazonaws.com"; value.candidate.namespace.region = "us-gov-west-1"; }
      if (reason === "no owner") delete value.candidate.namespace.expectedBucketOwner;
      if (reason === "old encryption") value.evidence.credential.status = "needs_reenvelope";
      if (reason === "no success") value.evidence.evidence.exactCurrentContextSuccess = null;
      if (reason === "unfinished cleanup") value.evidence.evidence.unresolvedCleanupCount = 1;
      if (reason === "running test") value.evidence.evidence.inProgressCount = 1;
      if (reason === "busy configuration") value.blocked = true;
      await act(async () => { render(<StorageProfileRegistration {...value} />); });
      expect(screen.queryByRole("button", { name: "Register profile" })).toBeNull(); expect(posts()).toHaveLength(0);
    });
  }

  it("keeps registration unavailable until a failed registration-status read is refreshed", async () => {
    network.mockResolvedValueOnce(json({ error: "private-server-detail" }, 503));
    render(<StorageProfileRegistration {...props()} />); await screen.findByText("Profile registration status is unavailable.");
    expect(screen.queryByRole("button", { name: "Register profile" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh registration status" }));
    await screen.findByRole("button", { name: "Register profile" });
    expect(posts()).toHaveLength(0); expect(document.body.textContent).not.toContain("private-server-detail");
  });

  it("reconciles a lost registration response with GET without replaying the mutation", async () => {
    let submitted!: StorageProfileAdmissionInput;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { submitted = JSON.parse(String(options.body)); throw new Error("private-failure"); }
      return String(path).includes("/registrations?") ? json({}, 404) : json(receipt(submitted));
    });
    render(<StorageProfileRegistration {...props()} />); fireEvent.click(await screen.findByRole("button", { name: "Register profile" }));
    await screen.findByText(nativeProfileId); expect(posts()).toHaveLength(1);
    expect(network.mock.calls.some(([path]) => path === `/api/storage/configuration/registrations/${submitted.operationId}`)).toBe(true);
    expect(document.body.textContent).not.toContain("private-failure");
  });

  it("retains a lost intent through reload and retries only the same intent on an explicit click", async () => {
    let attempts = 0, submitted!: StorageProfileAdmissionInput;
    network.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") {
        const value = JSON.parse(String(options.body));
        if (++attempts === 1) { submitted = value; throw new Error("lost response"); }
        expect(value).toEqual(submitted); return json(receipt(value));
      }
      return json({}, 404);
    });
    const first = render(<StorageProfileRegistration {...props()} />); fireEvent.click(await screen.findByRole("button", { name: "Register profile" }));
    await screen.findByText(/The registration result is unavailable/);
    first.unmount(); render(<StorageProfileRegistration {...props()} />);
    await screen.findByText(/The registration result is unavailable/); expect(posts()).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Check or retry registration" }));
    await screen.findByText(nativeProfileId); expect(posts()).toHaveLength(2);
    expect(JSON.parse(sessionStorage.getItem(sessionKey)!)).toEqual(submitted);
  });

  it("replays an unchanged earlier intent explicitly, settles stale conflict and permits a newly qualified registration", async () => {
    sessionStorage.setItem(sessionKey, JSON.stringify(input()));
    const value = props(); value.candidate.revision = 2; value.evidence.revision = 2;
    network.mockImplementation(async (path, options) => {
      if (String(path).includes("/readiness?")) return json(value.evidence);
      if (options?.method === "POST") {
        const submitted = JSON.parse(String(options.body)) as StorageProfileAdmissionInput;
        if (submitted.operationId === operationId) {
          expect(submitted).toEqual(input()); return json({}, 409);
        }
        expect(submitted).toMatchObject({ profileId: "candidate-example", expectedRevision: 2, expectedEnvelopeRevision: 2, checkId });
        return json(receipt(submitted));
      }
      return json({}, 404);
    });
    render(<StorageCandidateReadiness candidate={value.candidate} evidenceGeneration={0} blocked={false} onForbidden={value.onForbidden} />);
    await screen.findByText(/The registration result is unavailable/);
    expect(JSON.parse(sessionStorage.getItem(sessionKey)!)).toEqual(input()); expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Check or retry registration" }));
    await screen.findByText(/This storage may already be registered/);
    expect(JSON.parse(String(posts()[0][1]?.body))).toEqual(input()); expect(sessionStorage.getItem(sessionKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Register profile" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));
    fireEvent.click(await screen.findByRole("button", { name: "Register profile" }));
    await screen.findByText(nativeProfileId); expect(posts()).toHaveLength(2);
    expect(JSON.parse(String(posts()[1][1]?.body)).operationId).not.toBe(operationId);
  });

  it("allows explicit original-intent replay with unavailable current credentials but keeps unknown outcomes pending", async () => {
    sessionStorage.setItem(sessionKey, JSON.stringify(input()));
    const value = props(); value.evidence.credential.status = "unavailable";
    network.mockImplementation(async (_path, options) => options?.method === "POST" ? json({}, 503) : json({}, 404));
    render(<StorageProfileRegistration {...value} />); await screen.findByText(/The registration result is unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Check or retry registration" }));
    await screen.findByText(/The registration result is unavailable/);
    expect(posts()).toHaveLength(1); expect(JSON.parse(String(posts()[0][1]?.body))).toEqual(input());
    expect(JSON.parse(sessionStorage.getItem(sessionKey)!)).toEqual(input());
  });

  it("uses the latest blocked state to limit an explicit reconciliation to GET", async () => {
    sessionStorage.setItem(sessionKey, JSON.stringify(input()));
    const value = props(), mounted = render(<StorageProfileRegistration {...value} />);
    await screen.findByText(/The registration result is unavailable/);
    mounted.rerender(<StorageProfileRegistration {...value} blocked />);
    fireEvent.click(screen.getByRole("button", { name: "Check registration status" }));
    await screen.findByText(/The registration result is unavailable/);
    expect(posts()).toHaveLength(0); expect(JSON.parse(sessionStorage.getItem(sessionKey)!)).toEqual(input());
  });

  it("refreshes registration lookup after a conflict so a profile registered elsewhere is shown", async () => {
    let registeredElsewhere = false;
    const value = props();
    network.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") { registeredElsewhere = true; return json({}, 409); }
      return registeredElsewhere ? json({ ...receipt(), profileId: "another-candidate", revision: 7 }) : json({}, 404);
    });
    render(<StorageProfileRegistration {...value} />); fireEvent.click(await screen.findByRole("button", { name: "Register profile" }));
    await screen.findByText(nativeProfileId);
    expect(screen.queryByRole("button", { name: "Register profile" })).toBeNull();
    expect(value.onStaleEvidence).toHaveBeenCalledOnce(); expect(sessionStorage.getItem(sessionKey)).toBeNull();
  });

  it("invalidates stale evidence on conflict and never echoes the server diagnostic", async () => {
    const value = props(); network.mockImplementation(async (_path, options) => options?.method === "POST"
      ? json({ error: "private-registration-conflict" }, 409) : json({}, 404));
    render(<StorageProfileRegistration {...value} />); fireEvent.click(await screen.findByRole("button", { name: "Register profile" }));
    await screen.findByText(/This storage may already be registered/);
    expect(value.onStaleEvidence).toHaveBeenCalledOnce(); expect(sessionStorage.getItem(sessionKey)).toBeNull();
    expect(posts()).toHaveLength(1); expect(document.body.textContent).not.toContain("private-registration-conflict");
  });

  it("revokes administrator access on a forbidden lookup without offering registration", async () => {
    const value = props(); network.mockResolvedValue(json({}, 403));
    render(<StorageProfileRegistration {...value} />); await waitFor(() => expect(value.onForbidden).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Register profile" })).toBeNull(); expect(posts()).toHaveLength(0);
  });
});
