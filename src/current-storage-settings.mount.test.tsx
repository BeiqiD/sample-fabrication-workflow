import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentStorageSettingsStatus } from "../shared/contracts/current-storage-settings";
import type { NativeStorageActivationInput, StorageRolePolicyInput } from "../shared/contracts/storage-policy";
import type { StorageCandidate } from "../shared/contracts/storage-configuration";
import type { StorageCandidateReadiness } from "../shared/contracts/storage-candidate-readiness";
import { StorageSettingsPage } from "./pages/StorageSettingsPage";
import { StorageProfileActivation } from "./pages/StorageProfileActivation";
import { StorageCandidateReadiness as CandidateReadinessPanel } from "./pages/StorageCandidateReadiness";

const nativeId = `storage-profile:aws-s3:${"a".repeat(64)}`, checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63";
const snapshot = (): CurrentStorageSettingsStatus => ({ version: 3, kind: "storage-settings-status", readOnly: true, health: "not_checked",
  authority: { mode: "active", shadowConversions: "paused", fileAccess: "enabled" },
  roleDefaults: { state: "configured", policyRevision: 3, internal: { profileId: "r2-profile", adapterType: "r2", availability: "available" },
    originals: { profileId: nativeId, adapterType: "s3", availability: "available" } },
  bindings: { r2: { configuration: "configured" }, managed: { provider: "none", configuration: "missing" } },
  profiles: { items: [
    { id: "r2-profile", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: null, availability: "available" },
    { id: nativeId, adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_write", bindingMatch: "matched", bindingRevision: 1, availability: "available" },
    { id: "registered-s3", adapterType: "s3", configurationRevision: 1, runtimeAccess: "read_only", bindingMatch: "registered", bindingRevision: null, availability: "registered" },
  ], hasMore: false, limit: 100 } });
const candidate = (): StorageCandidate => ({ profileId: "candidate", revision: 2, label: "Research files",
  namespace: { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "private-bucket", root: "private-root",
    forcePathStyle: true, expectedBucketOwner: "123456789012" }, credentials: { status: "configured", ref: "private-credential-ref" },
  createdAt: "2026-10-05T00:00:00.000Z", createdBy: "private-admin@example.test" });
const evidence = (): StorageCandidateReadiness => ({ profileId: "candidate", revision: 2, observedAt: "2026-10-05T00:00:00.000Z",
  credential: { status: "current", envelopeRevision: 4 }, evidence: { currentConfigurationSuccessCount: 1, historicalConfigurationSuccessCount: 0,
    exactCurrentContextSuccess: { checkId, completedAt: "2026-10-05T00:00:00.000Z" }, inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
const receipt = (input: StorageRolePolicyInput) => ({ operationId: input.operationId, policyRevision: Math.max(3, (input.expectedPolicyRevision ?? 2) + 1),
  internalProfileId: input.internalProfileId, originalsProfileId: input.originalsProfileId, createdAt: "2026-10-05T00:00:00.000Z", createdBy: "private-admin@example.test" });
const activationReceipt = (input: NativeStorageActivationInput) => ({ operationId: input.operationId, nativeProfileId: input.nativeProfileId,
  candidateProfileId: input.candidateProfileId, candidateRevision: input.expectedCandidateRevision, envelopeRevision: input.expectedEnvelopeRevision,
  checkId: input.checkId, bindingRevision: (input.expectedBindingRevision ?? 0) + 1, createdAt: "2026-10-05T00:00:00.000Z", createdBy: "private-admin@example.test" });
const settingsPath = "/api/settings/storage?version=3";
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal("fetch", network); network.mockReset(); network.mockImplementation(async path =>
  String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true }) : String(path) === settingsPath ? json(snapshot()) : json({}, 404)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });
async function saveButton() {
  const value = await screen.findByRole("button", { name: "Save upload destinations" });
  await waitFor(() => expect((value as HTMLButtonElement).disabled).toBe(false)); return value;
}
const mutations = () => network.mock.calls.filter(([, options]) => ["PUT", "POST"].includes(options?.method ?? ""));
describe("current storage Settings controls", () => {
  it("shows exact unavailable S3 choices and registration while keeping a nonadministrator read only", async () => {
    const value = snapshot(); value.roleDefaults.originals!.availability = "unavailable"; value.profiles.items[1].availability = "unavailable";
    value.profiles.items[1].bindingMatch = "mismatch"; value.profiles.items[1].bindingRevision = null;
    network.mockImplementation(async path => String(path) === settingsPath ? json(value) : json({ canManage: false, credentialEditingAvailable: false }));
    render(<StorageSettingsPage />); await screen.findByText("Only system administrators can change upload destinations.");
    const original = within(screen.getByRole("heading", { name: "Original comment files" }).closest("article")!);
    expect(original.getByText("S3")).toBeTruthy(); expect(original.getByText(nativeId)).toBeTruthy(); expect(original.queryByText("Cloudflare R2")).toBeNull();
    expect(original.getByText("Unavailable in the current configuration")).toBeTruthy();
    expect(screen.getByText("Registered; activation required")).toBeTruthy(); expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.body.textContent).not.toMatch(/File access is not available for this registered profile|private-/); expect(mutations()).toHaveLength(0);
  });
  it("saves independent profile choices with the observed CAS revision and a durable request identifier", async () => {
    let submitted!: StorageRolePolicyInput, value = snapshot();
    network.mockImplementation(async (path, options) => {
      if (options?.method === "PUT") {
        submitted = JSON.parse(String(options.body)); expect(JSON.parse(sessionStorage.getItem("storage-role-policy:pending")!)).toEqual(submitted);
        value = snapshot(); value.roleDefaults.policyRevision = 4;
        value.roleDefaults.internal = { profileId: nativeId, adapterType: "s3", availability: "available" };
        value.roleDefaults.originals = { profileId: "r2-profile", adapterType: "r2", availability: "available" };
        return json(receipt(submitted));
      }
      return String(path) === settingsPath ? json(value) : json({ canManage: true, credentialEditingAvailable: true });
    });
    render(<StorageSettingsPage />); const save = await saveButton();
    fireEvent.change(screen.getByLabelText("Images and Project attachments"), { target: { value: nativeId } });
    fireEvent.change(screen.getByLabelText("Original comment files"), { target: { value: "r2-profile" } }); fireEvent.click(save);
    await waitFor(() => expect(sessionStorage.getItem("storage-role-policy:pending")).toBeNull());
    expect(submitted).toMatchObject({ expectedPolicyRevision: 3, internalProfileId: nativeId, originalsProfileId: "r2-profile" });
    expect(mutations()).toHaveLength(1); expect(mutations()[0][0]).toBe("/api/settings/storage/defaults");
    expect(document.body.textContent).not.toContain("private-admin");
  });
  it("reconciles a lost save response through its receipt without automatically repeating the mutation", async () => {
    let submitted!: StorageRolePolicyInput;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "PUT") { submitted = JSON.parse(String(options.body)); throw new Error("private-network-detail"); }
      if (String(path).includes("/defaults/")) return json(receipt(submitted));
      return String(path) === settingsPath ? json(snapshot()) : json({ canManage: true, credentialEditingAvailable: true });
    });
    render(<StorageSettingsPage />); fireEvent.click(await saveButton());
    await waitFor(() => expect(network.mock.calls.some(([path]) => path === `/api/settings/storage/defaults/${submitted.operationId}`)).toBe(true));
    await waitFor(() => expect(sessionStorage.getItem("storage-role-policy:pending")).toBeNull());
    expect(mutations()).toHaveLength(1); expect(document.body.textContent).not.toContain("private-network-detail");
  });
  it("preserves an uncertain original intent across reload and rejects a stale replay before allowing another edit", async () => {
    let attempts = 0, submitted!: StorageRolePolicyInput;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "PUT") {
        const input = JSON.parse(String(options.body)); if (++attempts === 1) { submitted = input; throw new Error("lost"); }
        expect(input).toEqual(submitted); return json({ error: "private-conflict" }, 409);
      }
      if (String(path).includes("/defaults/")) return json({}, 404);
      return String(path) === settingsPath ? json(snapshot()) : json({ canManage: true, credentialEditingAvailable: true });
    });
    const first = render(<StorageSettingsPage />); fireEvent.click(await saveButton());
    await screen.findByText(/The save result is unconfirmed/); first.unmount(); render(<StorageSettingsPage />);
    await screen.findByText(/The save result is unconfirmed/); expect(mutations()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check or retry save" }));
    await screen.findByText(/The selected profiles or policy changed/); expect(mutations()).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Save upload destinations" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(sessionStorage.getItem("storage-role-policy:pending")).toBeNull(); expect(document.body.textContent).not.toContain("private-conflict");
  });
  it("disables mutations while File access is paused and after current administrator access is revoked", async () => {
    const value = snapshot(); value.authority.fileAccess = "paused";
    network.mockImplementation(async path => String(path) === settingsPath ? json(value) : json({ canManage: true, credentialEditingAvailable: true }));
    const first = render(<StorageSettingsPage />); await screen.findByText(/Upload destination changes are unavailable/);
    expect((screen.getByRole("button", { name: "Save upload destinations" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true); expect(mutations()).toHaveLength(0); first.unmount();
    network.mockImplementation(async (path, options) => options?.method === "PUT" ? json({ error: "private-role-detail" }, 403)
      : String(path) === settingsPath ? json(snapshot()) : json({ canManage: true, credentialEditingAvailable: true }));
    render(<StorageSettingsPage />); fireEvent.click(await saveButton()); await screen.findByText("Only system administrators can change upload destinations.");
    expect(screen.queryByRole("combobox")).toBeNull(); expect(document.body.textContent).not.toContain("private-role-detail");
  });
  it("rejects private fields in a successor response before displaying settings", async () => {
    network.mockResolvedValue(json({ ...snapshot(), credentialRef: "private-credential" }));
    render(<StorageSettingsPage />); await screen.findByRole("alert"); expect(document.body.textContent).not.toContain("private-credential"); expect(screen.queryByText("registered-s3")).toBeNull();
  });
  it("offers an independently mapped R2 profile even when the bootstrap binding is missing", async () => {
    const value = snapshot(); value.bindings.r2.configuration = "missing";
    value.roleDefaults.internal!.availability = "unavailable"; value.profiles.items[0].availability = "unavailable";
    value.profiles.items[0].bindingMatch = "not_configured";
    value.profiles.items.push({ id: "r2-independent", adapterType: "r2", configurationRevision: 1, runtimeAccess: "read_write",
      bindingMatch: "matched", bindingRevision: null, availability: "available" });
    network.mockImplementation(async path => String(path) === settingsPath ? json(value) : json({ canManage: true, credentialEditingAvailable: true }));
    render(<StorageSettingsPage />); await screen.findByText("r2-independent");
    const select = await screen.findByLabelText("Images and Project attachments"), save = screen.getByRole("button", { name: "Save upload destinations" });
    await waitFor(() => expect((select.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((within(select).getByRole("option", { name: "r2-profile (unavailable)" }) as HTMLOptionElement).disabled).toBe(true);
    const mapped = within(select).getByRole("option", { name: "Cloudflare R2 · r2-independent" }); expect((mapped as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(select, { target: { value: "r2-independent" } }); expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(mutations()).toHaveLength(0);
  });
});

describe("registered native profile activation controls", () => {
  const props = () => ({ candidate: candidate(), nativeProfileId: nativeId, evidence: evidence(), blocked: false, onForbidden: vi.fn(), onStaleEvidence: vi.fn() });
  it("offers activation from a registered candidate's exact evidence panel", async () => {
    network.mockImplementation(async path => {
      if (String(path).includes("/readiness?")) return json(evidence());
      if (String(path).includes("/registrations?")) return json({ operationId: "d8992768-d864-444b-8e97-e58a5d8f40b0", profileId: "candidate", revision: 2,
        envelopeRevision: 4, checkId, nativeProfileId: nativeId, configurationRevision: 1, runtimeAccess: "read_only",
        createdAt: "2026-10-05T00:00:00.000Z", createdBy: "private-admin@example.test" });
      return json(snapshot());
    });
    render(<CandidateReadinessPanel candidate={candidate()} evidenceGeneration={0} blocked={false} onForbidden={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Check evidence for Research files" }));
    const button = await screen.findByRole("button", { name: "Update profile activation" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("is registered. Review its activation below.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Choose upload destinations" })).toBeTruthy(); expect(mutations()).toHaveLength(0);
  });
  it("activates the exact current candidate, envelope and successful check with observed binding CAS", async () => {
    let submitted!: NativeStorageActivationInput;
    network.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") { submitted = JSON.parse(String(options.body));
        expect(JSON.parse(sessionStorage.getItem("storage-profile-activation:candidate")!)).toEqual(submitted); return json(activationReceipt(submitted)); }
      return json(snapshot());
    });
    render(<StorageProfileActivation {...props()} />);
    const button = await screen.findByRole("button", { name: "Update profile activation" }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button);
    await screen.findByText(/Profile activation confirmed/);
    expect(submitted).toMatchObject({ nativeProfileId: nativeId, candidateProfileId: "candidate", expectedCandidateRevision: 2, expectedEnvelopeRevision: 4,
      checkId, expectedBindingRevision: 1 }); expect(mutations()).toHaveLength(1); expect(sessionStorage.getItem("storage-profile-activation:candidate")).toBeNull();
    expect(screen.getByRole("link", { name: "Choose upload destinations" })).toBeTruthy(); expect(document.body.textContent).not.toMatch(/private-bucket|private-root|private-admin|private-credential/);
  });
  it("rebinds restored writable history with no local binding while accepting the continued portable activation revision", async () => {
    const value = snapshot(); value.profiles.items[1].bindingRevision = null; value.profiles.items[1].bindingMatch = "mismatch";
    value.profiles.items[1].availability = "unavailable"; value.roleDefaults.originals!.availability = "unavailable";
    let submitted!: NativeStorageActivationInput;
    network.mockImplementation(async (_path, options) => {
      if (options?.method === "POST") { submitted = JSON.parse(String(options.body)); return json({ ...activationReceipt(submitted), bindingRevision: 3 }); }
      return json(value);
    });
    render(<StorageProfileActivation {...props()} />); const button = await screen.findByRole("button", { name: "Activate profile" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button);
    await screen.findByText(/Profile activation confirmed/); expect(submitted.expectedBindingRevision).toBeNull();
    expect(sessionStorage.getItem("storage-profile-activation:candidate")).toBeNull(); expect(mutations()).toHaveLength(1);
  });
  it.each(["no evidence", "old credentials", "cleanup pending", "file paused", "configuration busy"])("keeps activation disabled for %s", async reason => {
    const value = props(), status = snapshot();
    if (reason === "no evidence") value.evidence.evidence.exactCurrentContextSuccess = null;
    if (reason === "old credentials") value.evidence.credential.status = "needs_reenvelope";
    if (reason === "cleanup pending") value.evidence.evidence.unresolvedCleanupCount = 1;
    if (reason === "file paused") status.authority.fileAccess = "paused";
    if (reason === "configuration busy") value.blocked = true;
    network.mockResolvedValue(json(status)); await act(async () => render(<StorageProfileActivation {...value} />));
    expect((screen.getByRole("button", { name: "Update profile activation" }) as HTMLButtonElement).disabled).toBe(true); expect(mutations()).toHaveLength(0);
  });
  it("reads an uncertain activation receipt and retries the unchanged intent only on an explicit click", async () => {
    let attempts = 0, submitted!: NativeStorageActivationInput;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { const input = JSON.parse(String(options.body)); if (++attempts === 1) { submitted = input; throw new Error("private-network-detail"); }
        expect(input).toEqual(submitted); return json(activationReceipt(input)); }
      return String(path) === settingsPath ? json(snapshot()) : json({}, 404);
    });
    const first = render(<StorageProfileActivation {...props()} />); const button = await screen.findByRole("button", { name: "Update profile activation" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button); await screen.findByText(/The activation result is unconfirmed/);
    first.unmount(); render(<StorageProfileActivation {...props()} />); await screen.findByText(/The activation result is unconfirmed/); expect(mutations()).toHaveLength(1);
    const retry = await screen.findByRole("button", { name: "Check or retry activation" }); await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(retry);
    await screen.findByText(/Profile activation confirmed/); expect(mutations()).toHaveLength(2); expect(document.body.textContent).not.toContain("private-network-detail");
  });
});
