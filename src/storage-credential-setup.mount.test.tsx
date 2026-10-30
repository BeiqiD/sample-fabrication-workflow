import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkedInstallationSecretSeed } from "../shared/contracts/installation-secret-seed";
import type { StorageCandidate, StorageConfigurationStatus } from "../shared/contracts/storage-configuration";
import type { StorageCredentialSetupStatus } from "../shared/contracts/storage-credential-setup";
import type { StorageCandidateCheck } from "../shared/contracts/storage-candidate-check";
import type { StorageProfileAdmissionReceipt } from "../shared/contracts/storage-profile-admission";
import type { NativeStorageActivationReceipt } from "../shared/contracts/storage-policy";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import { readApplicationIdentity } from "./lib/authentication-client";
import { StorageConfigurationPage } from "./pages/StorageConfigurationPage";

const prefix = "/api/storage/configuration", readinessPath = `${prefix}/encryption-readiness`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>(), copy = vi.fn<(value: string) => Promise<void>>();
let rootReady: boolean, administrator: boolean, rootState: StorageCredentialSetupStatus["state"], subject: string;
let candidates: StorageCandidate[], clipboardDescriptor: PropertyDescriptor | undefined;
const configuration = (): StorageConfigurationStatus => ({ scope: "system", credentialEditingAvailable: rootReady,
  candidates: { items: candidates, hasMore: false } });
const writes = () => network.mock.calls.filter(([, init]) => !["GET", undefined].includes(init?.method));
const readinessReads = () => network.mock.calls.filter(([path]) => String(path) === readinessPath);
const enter = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function startSetup() {
  fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
  return screen.findByRole("button", { name: "Generate seed" });
}
function displayedSeed(): string { return screen.getByLabelText("Installation seed").textContent!; }

beforeEach(async () => {
  rootReady = false; administrator = true; rootState = "setup_required"; subject = "a".repeat(64); candidates = [];
  copy.mockReset(); copy.mockResolvedValue(undefined); network.mockReset();
  vi.stubGlobal("isSecureContext", true); vi.stubGlobal("fetch", network);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  network.mockImplementation(async (path, init) => {
    const url = String(path);
    if (url === "/api/identity") return json({ schema: "application-identity/1", subject });
    if (url === `${prefix}/capability`) return json({ canManage: administrator, credentialEditingAvailable: administrator && rootReady });
    if (url === prefix) return administrator ? json(configuration()) : json({}, 403);
    if (url === readinessPath) return administrator ? json({ version: 1, runtime: "cloudflare_worker", state: rootState }) : json({}, 403);
    if (url.includes("/checks?")) return json({ items: [], hasMore: false });
    if (url === `${prefix}/candidates` && init?.method === "PUT") {
      const input = JSON.parse(String(init.body));
      const item: StorageCandidate = { profileId: `candidate-${candidates.length + 1}`, revision: 1, label: input.label,
        namespace: input.namespace, credentials: { status: "configured", ref: "opaque-reference" },
        createdAt: "2026-10-20T12:00:00.000Z", createdBy: "admin@example.org" };
      candidates.push(item); return json(item);
    }
    return json({}, 404);
  });
  await readApplicationIdentity();
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("first external S3 credential setup", () => {
  it("keeps ordinary R2 use and read-only administration free from a seed prompt or readiness request", async () => {
    render(<StorageConfigurationPage />); await screen.findByRole("heading", { name: "Add storage" });
    expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull();
    expect(screen.queryByLabelText("Access key ID")).toBeNull();
    expect(readinessReads()).toHaveLength(0); expect(writes()).toHaveLength(0);
    expect(screen.getByText(/Cloudflare R2 storage does not require external credentials/)).toBeTruthy();
  });

  it("generates 32 CSPRNG bytes only on request, copies ephemerally, and continues without sending the seed", async () => {
    const random = vi.spyOn(crypto, "getRandomValues"), persist = vi.spyOn(Storage.prototype, "setItem");
    render(<StorageConfigurationPage />); const generate = await startSetup();
    expect(random).not.toHaveBeenCalled(); expect(screen.queryByLabelText("Secret access key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    fireEvent.click(generate); const seed = displayedSeed();
    expect(random).toHaveBeenCalledOnce(); expect((random.mock.calls[0][0] as Uint8Array).byteLength).toBe(32);
    const bytes = checkedInstallationSecretSeed(seed); expect(bytes).toHaveLength(32); bytes.fill(0);
    expect(seed).toMatch(/^sfi-seed-v1\.[A-Za-z0-9_-]{43}$/);
    fireEvent.click(screen.getByRole("button", { name: "Copy seed" }));
    await screen.findByText("Seed copied. Save a protected recovery backup before continuing.");
    expect(copy).toHaveBeenCalledWith(seed); expect(persist).not.toHaveBeenCalled();
    expect(network.mock.calls.some(([, init]) => String(init?.body ?? "").includes(seed))).toBe(false);
    expect(writes()).toHaveLength(0);
    rootReady = true; rootState = "seed_ready";
    fireEvent.click(screen.getByRole("button", { name: "Recheck setup" }));
    await screen.findByLabelText("Access key ID");
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    expect(screen.queryByLabelText("Installation seed")).toBeNull(); expect(document.body.textContent).not.toContain(seed);
    expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull();
    expect((screen.getByLabelText("HTTPS endpoint") as HTMLInputElement).value).toBe("https://s3.us-east-1.amazonaws.com");
    expect(screen.getByRole("navigation", { name: "Add AWS S3 stages" })).toBeTruthy();
    expect(readinessReads()).toHaveLength(2); expect(writes()).toHaveLength(0);
  });

  it("reuses configured encryption for two additions and leaves tests, activation and upload defaults explicit", async () => {
    rootReady = true; rootState = "seed_ready";
    render(<StorageConfigurationPage />);
    for (const name of ["First AWS archive", "Second AWS archive"]) {
      fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
      enter("Name", name); enter("Bucket", "research-files"); enter("AWS bucket owner account ID", "123456789012");
      enter("Access key ID", "private-provider-key"); enter("Secret access key", "private-provider-secret");
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      await screen.findByRole("heading", { name });
      expect(screen.queryByLabelText("Secret access key")).toBeNull();
    }
    expect(writes()).toHaveLength(2); expect(writes().every(([, init]) => init?.method === "PUT")).toBe(true);
    expect(readinessReads()).toHaveLength(0); expect(copy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(screen.getByRole("link", { name: "Choose upload destinations" }).getAttribute("href")).toBe("/settings/storage");
    expect(network.mock.calls.some(([path]) => String(path).startsWith("/api/settings/storage"))).toBe(false);
  });

  it("continues an existing legacy keyring installation without seed generation or a Cloudflare setup visit", async () => {
    rootReady = true; rootState = "legacy_ready";
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    expect(screen.getByLabelText("Access key ID")).toBeTruthy(); expect(readinessReads()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull(); expect(writes()).toHaveLength(0);
  });

  it("advances only from the selected connection's verified stages and regresses when evidence or availability changes", async () => {
    rootReady = true; rootState = "seed_ready";
    const nativeId = `storage-profile:aws-s3:${"a".repeat(64)}`, settingsPath = "/api/settings/storage?version=3";
    let tested: StorageCandidateCheck | null = null, registered: StorageProfileAdmissionReceipt | null = null;
    let activated: NativeStorageActivationReceipt | null = null, available = true, currentEvidence = true;
    const settings = (): CurrentStorageSettingsStatus => ({ version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
      authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
      roleDefaults: { state: "configured", policyRevision: 2, internal: { profileId: "r2", adapterType: "r2", availability: "available" },
        originals: { profileId: "r2", adapterType: "r2", availability: "available" } },
      bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
      profiles: { items: [{ id: "r2", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched",
        bindingRevision: null, availability: "available" }, { id: nativeId, adapterType: "s3", configurationRevision: 1,
        runtimeAccess: activated ? "read_write" : "read_only", bindingMatch: activated ? available ? "matched" : "mismatch" : "registered",
        bindingRevision: activated?.bindingRevision ?? null, availability: activated ? available ? "available" : "unavailable" : "registered" }],
        hasMore: false, limit: 100 } });
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (path, init) => {
      const url = String(path);
      if (url === settingsPath) return json(settings());
      if (url.includes("/checks?")) return json({ items: tested ? [tested] : [], hasMore: false });
      if (url === `${prefix}/checks` && init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        tested = { id: input.checkId, profileId: input.profileId, revision: input.expectedRevision, status: "succeeded", write: "passed", read: "passed",
          metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: null, createdAt: "2026-10-20T12:00:00.000Z",
          updatedAt: "2026-10-20T12:00:01.000Z", completedAt: "2026-10-20T12:00:01.000Z" };
        return json(tested);
      }
      if (url.includes("/readiness?")) return json({ profileId: candidates[0].profileId, revision: candidates[0].revision,
        observedAt: "2026-10-20T12:00:02.000Z", credential: { status: "current", envelopeRevision: 1 }, evidence: {
          currentConfigurationSuccessCount: tested ? 1 : 0, historicalConfigurationSuccessCount: 0,
          exactCurrentContextSuccess: tested && currentEvidence ? { checkId: tested.id, completedAt: tested.completedAt } : null,
          inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
      if (url.includes("/registrations?")) return registered ? json(registered) : json({}, 404);
      if (url === `${prefix}/registrations` && init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        registered = { operationId: input.operationId, profileId: input.profileId, revision: input.expectedRevision,
          envelopeRevision: input.expectedEnvelopeRevision, checkId: input.checkId, nativeProfileId: nativeId, configurationRevision: 1,
          runtimeAccess: "read_only", createdAt: "2026-10-20T12:00:03.000Z", createdBy: "admin@example.org" };
        return json(registered);
      }
      if (url === `${prefix}/activations` && init?.method === "POST") {
        const input = JSON.parse(String(init.body));
        activated = { operationId: input.operationId, nativeProfileId: input.nativeProfileId, candidateProfileId: input.candidateProfileId,
          candidateRevision: input.expectedCandidateRevision, envelopeRevision: input.expectedEnvelopeRevision, checkId: input.checkId,
          bindingRevision: (input.expectedBindingRevision ?? 0) + 1, createdAt: "2026-10-20T12:00:04.000Z", createdBy: "admin@example.org" };
        return json(activated);
      }
      return original(path, init);
    });
    const stage = () => screen.getByRole("navigation", { name: "Add AWS S3 stages" }).querySelector('[aria-current="step"]')?.textContent;
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    enter("Name", "Wizard archive"); enter("Bucket", "research-files"); enter("AWS bucket owner account ID", "123456789012");
    enter("Access key ID", "private-key"); enter("Secret access key", "private-secret");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" })); await screen.findByRole("heading", { name: "Wizard archive" });
    await waitFor(() => expect(stage()).toBe("Test connection"));
    const test = await screen.findByRole("button", { name: "Test Wizard archive" });
    await waitFor(() => expect((test as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(test);
    await waitFor(() => expect(stage()).toBe("Review evidence and register"));
    fireEvent.click(screen.getByRole("button", { name: "Check evidence for Wizard archive" }));
    const register = await screen.findByRole("button", { name: "Register profile" }); fireEvent.click(register);
    await waitFor(() => expect(stage()).toBe("Confirm profile activation"));
    const activate = await screen.findByRole("button", { name: "Activate profile" });
    await waitFor(() => expect((activate as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(activate);
    await waitFor(() => expect(stage()).toBe("Choose upload destinations"));
    expect(screen.getByText(/Activation and current availability are confirmed for this connection/)).toBeTruthy();
    expect(writes()).toHaveLength(4); expect(network.mock.calls.some(([path, init]) => String(path).startsWith("/api/settings/storage") && init?.method === "PUT")).toBe(false);
    available = false; fireEvent.click(screen.getByRole("button", { name: "Refresh activation status" }));
    await waitFor(() => expect(stage()).toBe("Confirm profile activation"));
    available = true; await waitFor(() => expect((screen.getByRole("button", { name: "Refresh activation status" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh activation status" }));
    await waitFor(() => expect(stage()).toBe("Choose upload destinations"));
    currentEvidence = false; fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }));
    await screen.findByText("No recorded success matches the current configuration and stored credential version.");
    await waitFor(() => expect(stage()).toBe("Test connection"));
    fireEvent.click(screen.getByRole("button", { name: "Add AWS S3 storage" }));
    expect(stage()).toBe("Save connection");
    fireEvent.click(screen.getByRole("button", { name: "Refresh activation status" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh activation status" }) as HTMLButtonElement).disabled).toBe(false));
    expect(stage()).toBe("Save connection"); expect(writes()).toHaveLength(4);
  });

  it("recovers a lost candidate save only by reading and explicitly selecting its saved identity", async () => {
    rootReady = true; rootState = "seed_ready";
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      if (String(path) === `${prefix}/candidates` && init?.method === "PUT") throw new Error("Lost save acknowledgement");
      return response;
    });
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    enter("Name", "Recovered archive"); enter("Bucket", "research-files"); enter("AWS bucket owner account ID", "123456789012");
    enter("Access key ID", "private-key"); enter("Secret access key", "private-secret"); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("The save result is unavailable. Refresh saved candidates before trying again.");
    expect(screen.queryByText(/Setup selected:/)).toBeNull(); expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue setup for Recovered archive" }));
    expect(screen.getByText(/Setup selected:/).textContent).toBe("Setup selected: Recovered archive, revision 1.");
    expect(screen.getByRole("navigation", { name: "Add AWS S3 stages" }).querySelector('[aria-current="step"]')?.textContent).toBe("Test connection");
    expect(writes()).toHaveLength(1);
  });

  it("does not select a saved-response DTO whose revision differs from the original intent", async () => {
    rootReady = true; rootState = "seed_ready";
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (path, init) => {
      const response = await original(path, init);
      return String(path) === `${prefix}/candidates` && init?.method === "PUT" ? json({ ...await response.json(), revision: 2 }) : response;
    });
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    enter("Name", "Unconfirmed archive"); enter("Bucket", "research-files"); enter("AWS bucket owner account ID", "123456789012");
    enter("Access key ID", "private-key"); enter("Secret access key", "private-secret"); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("The save result is unavailable. Refresh saved candidates before trying again.");
    expect(screen.queryByText(/Setup selected:/)).toBeNull(); expect(writes()).toHaveLength(1);
    expect((screen.getByLabelText("Secret access key") as HTMLInputElement).value).toBe("");
  });

  it("labels a non-AWS endpoint as candidate-only and never starts native AWS setup progress", async () => {
    rootReady = true; rootState = "seed_ready";
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    enter("HTTPS endpoint", "https://objects.example.org");
    expect(screen.getByText(/S3-compatible candidate only: this endpoint is outside the supported AWS native path/)).toBeTruthy();
    expect(screen.queryByLabelText("AWS bucket owner account ID")).toBeNull();
    enter("Name", "Generic archive"); enter("Bucket", "research-files"); enter("Access key ID", "private-key"); enter("Secret access key", "private-secret");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" })); await screen.findByRole("heading", { name: "Generic archive" });
    expect(screen.getByText(/S3 compatible — candidate only · Draft/)).toBeTruthy(); expect(screen.queryByText(/Setup selected:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue setup for Generic archive" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Add AWS S3 stages" })).toBeNull(); expect(writes()).toHaveLength(1);
  });

  for (const [state, heading] of [["restore_required", "Restore existing seed/key"], ["configuration_conflict", "Resolve the existing secret configuration"]] as const) {
    it(`requires recovery for ${state} instead of offering a new root`, async () => {
      rootState = state; render(<StorageConfigurationPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
      await screen.findByRole("heading", { name: heading });
      expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull(); expect(screen.queryByLabelText("Access key ID")).toBeNull();
      expect(writes()).toHaveLength(0); expect(copy).not.toHaveBeenCalled();
    });
  }

  it("keeps setup unavailable rather than showing Worker-secret instructions for an unsupported runtime", async () => {
    const original = network.getMockImplementation()!;
    network.mockImplementation((path, init) => String(path) === readinessPath ? Promise.resolve(json({}, 404)) : original(path, init));
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    await screen.findByText(/Guided credential setup is unavailable for this installation/);
    expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull(); expect(screen.queryByText("INSTALLATION_SECRET_SEED")).toBeNull();
    expect(screen.queryByLabelText("Access key ID")).toBeNull(); expect(writes()).toHaveLength(0);
  });

  it("aborts a cancelled readiness request and ignores its late ready result", async () => {
    let finish!: (response: Response) => void, signal: AbortSignal | null | undefined;
    const original = network.getMockImplementation()!;
    network.mockImplementation((path, init) => String(path) === readinessPath
      ? new Promise<Response>(resolve => { finish = resolve; signal = init?.signal; }) : original(path, init));
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    await screen.findByText("Checking credential setup…"); fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(json({ version: 1, runtime: "cloudflare_worker", state: "seed_ready" })));
    expect(screen.queryByLabelText("Access key ID")).toBeNull(); expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull();
    expect(network.mock.calls.filter(([path]) => String(path) === `${prefix}/capability`)).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it("clears a displayed seed on cancellation and unmount without persisting it", async () => {
    const mounted = render(<StorageConfigurationPage />); fireEvent.click(await startSetup()); const seed = displayedSeed();
    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(document.body.textContent).not.toContain(seed); expect(screen.queryByLabelText("Installation seed")).toBeNull();
    fireEvent.click(await startSetup()); const second = displayedSeed(); mounted.unmount();
    expect(document.body.textContent).not.toContain(second); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it("removes an exposed seed and aborts setup when the authenticated account changes", async () => {
    render(<StorageConfigurationPage />); fireEvent.click(await startSetup()); const seed = displayedSeed();
    subject = "b".repeat(64); await act(async () => readApplicationIdentity());
    await screen.findByRole("heading", { name: "Read only" });
    expect(document.body.textContent).not.toContain(seed); expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add AWS S3 storage" })).toBeNull(); expect(writes()).toHaveLength(0);
  });

  it("never exposes setup to a reader and locks it after administrator revocation", async () => {
    administrator = false; const first = render(<StorageConfigurationPage />);
    await screen.findByRole("heading", { name: "Read only" });
    expect(screen.queryByRole("button", { name: "Add AWS S3 storage" })).toBeNull(); expect(readinessReads()).toHaveLength(0);
    first.unmount(); administrator = true; render(<StorageConfigurationPage />); fireEvent.click(await startSetup()); const seed = displayedSeed();
    administrator = false; fireEvent.click(screen.getByRole("button", { name: "Recheck setup" }));
    await screen.findByRole("heading", { name: "Read only" });
    expect(document.body.textContent).not.toContain(seed); expect(screen.queryByLabelText("Access key ID")).toBeNull(); expect(writes()).toHaveLength(0);
  });

  it("rejects extra secret-bearing readiness fields and never displays raw server errors", async () => {
    const original = network.getMockImplementation()!;
    network.mockImplementation((path, init) => String(path) === readinessPath
      ? Promise.resolve(json({ version: 1, runtime: "cloudflare_worker", state: "setup_required", seed: "private-root-detail" })) : original(path, init));
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Add AWS S3 storage" }));
    await screen.findByText("Credential setup status is unavailable. Recheck before continuing.");
    expect(document.body.textContent).not.toContain("private-root-detail"); expect(screen.queryByRole("button", { name: "Generate seed" })).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});
