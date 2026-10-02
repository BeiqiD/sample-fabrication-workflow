import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageCandidate, StorageConfigurationStatus } from "../shared/contracts/storage-configuration";
import type { ReenvelopeStorageCredentialInput, StorageCredentialEnvelopeMetadata, StorageCredentialReenvelopeReceipt } from "../shared/contracts/storage-credential-reenvelope";
import { StorageConfigurationPage } from "./pages/StorageConfigurationPage";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const profileId = "candidate-example", intentKey = `storage-credential-reenvelope:${profileId}`;
const candidate = (): StorageCandidate => ({ profileId, revision: 2, label: "Research archive",
  namespace: { kind: "s3", endpoint: "https://objects.example.org", bucket: "research-files", region: "us-east-1", root: "work", forcePathStyle: true },
  credentials: { status: "configured", ref: "opaque-current" }, createdAt: "2026-10-02T10:00:00.000Z", createdBy: "admin@example.org" });
const configuration = (item = candidate()): StorageConfigurationStatus => ({ scope: "system", credentialEditingAvailable: true, candidates: { items: [item], hasMore: false } });
const envelope = (changes: Partial<StorageCredentialEnvelopeMetadata> = {}): StorageCredentialEnvelopeMetadata => ({ profileId, revision: 2,
  credentialRef: "opaque-current", envelopeRevision: 1, isCurrentCandidate: true, status: "needs_reenvelope", ...changes });
const receipt = (input: ReenvelopeStorageCredentialInput, changes: Partial<StorageCredentialReenvelopeReceipt> = {}): StorageCredentialReenvelopeReceipt => ({
  operationId: input.operationId, profileId: input.profileId, revision: input.revision, credentialRef: input.credentialRef,
  previousEnvelopeRevision: input.expectedEnvelopeRevision, envelopeRevision: input.expectedEnvelopeRevision + 1, outcome: "reenveloped",
  createdAt: "2026-10-02T10:01:00.000Z", createdBy: "admin@example.org", ...changes,
});
const network = vi.fn<typeof fetch>();
const envelopeList = (items: StorageCredentialEnvelopeMetadata[] = [envelope()], hasMore = false) => json({ items, hasMore });
const fallback = (path: RequestInfo | URL) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
  : String(path).includes("/checks?") ? json({ items: [], hasMore: false }) : String(path).includes("/credential-envelopes?") ? envelopeList() : json(configuration());
const posts = () => network.mock.calls.filter(([, options]) => options?.method === "POST");
beforeEach(() => { vi.stubGlobal("fetch", network); network.mockReset(); network.mockImplementation(async path => fallback(path)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
async function openEncryption() {
  fireEvent.click(await screen.findByRole("button", { name: "Credential encryption for Research archive" }));
  return screen.findByRole("region", { name: "Credential encryption for Research archive" });
}
async function readyUpdate(revision = 2) {
  const button = await screen.findByRole("button", { name: `Update encryption for revision ${revision}` });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button;
}

describe("administrator credential encryption Settings", () => {
  it("does not request encryption metadata or offer actions without administrator capability", async () => {
    network.mockResolvedValue(json({ canManage: false, credentialEditingAvailable: false }));
    render(<StorageConfigurationPage />); await screen.findByRole("heading", { name: "Read only" });
    expect(network).toHaveBeenCalledOnce(); expect(screen.queryByRole("button", { name: /Credential encryption/ })).toBeNull();
  });

  it("loads bounded metadata only on expansion and updates a historical row without browser key material", async () => {
    let updated = false, input!: ReenvelopeStorageCredentialInput;
    network.mockImplementation(async (path, options) => {
      if (String(path).includes("/credential-envelopes?")) return envelopeList([envelope({ status: "current" }), envelope({ revision: 1,
        credentialRef: "opaque-historical", isCurrentCandidate: false, status: updated ? "current" : "needs_reenvelope", envelopeRevision: updated ? 2 : 1 })], true);
      if (options?.method === "POST") { input = JSON.parse(String(options.body));
        expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(input); updated = true; return json(receipt(input)); }
      return fallback(path);
    });
    render(<StorageConfigurationPage />); await screen.findByText("Research archive");
    expect(network.mock.calls.some(([path]) => String(path).includes("/credential-envelopes?"))).toBe(false);
    const panel = await openEncryption();
    await screen.findByText("Historical credential revision 1");
    expect(within(panel).getByText("Additional retained credential revisions are not shown.")).toBeTruthy();
    expect(within(panel).getByText(/immutable connection test snapshots and installation backups/)).toBeTruthy();
    fireEvent.click(await readyUpdate(1));
    await screen.findByText("Credential encryption updated for revision 1.");
    expect(input).toMatchObject({ profileId, revision: 1, credentialRef: "opaque-historical", expectedEnvelopeRevision: 1 });
    expect(Object.keys(input).sort()).toEqual(["credentialRef", "expectedEnvelopeRevision", "operationId", "profileId", "revision"]);
    expect(posts()).toHaveLength(1); expect(posts()[0][0]).toBe("/api/storage/configuration/credential-reenvelopes");
    expect(network.mock.calls.every(([path]) => String(path).startsWith("/api/storage/configuration"))).toBe(true);
    expect(network.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
    expect(document.body.textContent).not.toContain("opaque-historical"); expect(document.body.textContent).not.toContain("admin@example.org");
    expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0);
  });

  it("reconciles a committed 503 response from its durable receipt without a second POST", async () => {
    let input!: ReenvelopeStorageCredentialInput, updated = false;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { input = JSON.parse(String(options.body)); updated = true; return json({ error: "private-database-detail" }, 503); }
      if (String(path).includes("/credential-reenvelopes/")) return json(receipt(input));
      if (String(path).includes("/credential-envelopes?")) return envelopeList([envelope({ status: updated ? "current" : "needs_reenvelope", envelopeRevision: updated ? 2 : 1 })]);
      return fallback(path);
    });
    render(<StorageConfigurationPage />); await openEncryption(); fireEvent.click(await readyUpdate());
    await screen.findByText("Credential encryption updated for revision 2.");
    expect(posts()).toHaveLength(1); expect(network.mock.calls.some(([path]) => path === `/api/storage/configuration/credential-reenvelopes/${input.operationId}`)).toBe(true);
    expect(sessionStorage.length).toBe(0); expect(document.body.textContent).not.toContain("private-database-detail");
  });

  it("retains an unknown operation across reload and retries only its same ID after a 404", async () => {
    let input!: ReenvelopeStorageCredentialInput, attempt = 0, committed = false;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") {
        const submitted = JSON.parse(String(options.body));
        if (attempt++ === 0) { input = submitted; return json({ error: "private-keyring-detail" }, 503); }
        expect(submitted).toEqual(input); committed = true; return json(receipt(input));
      }
      if (String(path).includes("/credential-reenvelopes/")) return json({}, 404);
      if (String(path).includes("/credential-envelopes?")) return envelopeList([envelope({ status: committed ? "current" : "needs_reenvelope" })]);
      return fallback(path);
    });
    const first = render(<StorageConfigurationPage />); await openEncryption(); fireEvent.click(await readyUpdate());
    await screen.findByText("The encryption update result is unavailable. Check or retry this same operation.");
    expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(input);
    expect((screen.getByRole("button", { name: "Update encryption for revision 2" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount(); render(<StorageConfigurationPage />);
    await screen.findByText("The encryption update result is unavailable. Check or retry this same operation.");
    expect(posts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Check or retry encryption update" }));
    await screen.findByText("Credential encryption updated for revision 2.");
    expect(posts()).toHaveLength(2); expect(sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain("private-keyring-detail");
  });

  it("reloads authoritative metadata after a CAS conflict and never reuses the rejected intent", async () => {
    let changed = false;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { changed = true; return json({}, 409); }
      if (String(path).includes("/credential-envelopes?")) return envelopeList([envelope({ status: changed ? "current" : "needs_reenvelope", envelopeRevision: changed ? 2 : 1 })]);
      return fallback(path);
    });
    render(<StorageConfigurationPage />); await openEncryption(); fireEvent.click(await readyUpdate());
    await screen.findByText("Stored credential encryption changed. Read the latest status before trying again.");
    await screen.findByText("Uses the current encryption key");
    expect(screen.queryByRole("button", { name: "Update encryption for revision 2" })).toBeNull();
    expect(sessionStorage.length).toBe(0); expect(posts()).toHaveLength(1);
  });

  it("offers no update for unavailable payloads and does not render rejected secret fields", async () => {
    let secret = false;
    network.mockImplementation(async path => String(path).includes("/credential-envelopes?") ? secret
      ? json({ items: [{ ...envelope(), keyId: "private-key-id", ciphertext: "private-ciphertext" }], hasMore: false })
      : envelopeList([envelope({ status: "unavailable", envelopeRevision: null })]) : fallback(path));
    render(<StorageConfigurationPage />); await openEncryption(); await screen.findByText("Encryption unavailable");
    expect(screen.queryByRole("button", { name: /Update encryption for revision/ })).toBeNull();
    secret = true; fireEvent.click(screen.getByRole("button", { name: "Refresh encryption status" }));
    await screen.findByText("Credential encryption status is unavailable. Refresh encryption status to try again.");
    expect(document.body.textContent).not.toContain("private-key-id"); expect(document.body.textContent).not.toContain("private-ciphertext");
    expect(posts()).toHaveLength(0);
  });

  it("hides administrator controls and stops requests after a forbidden encryption read", async () => {
    network.mockImplementation(async path => String(path).includes("/credential-envelopes?") ? json({}, 403) : fallback(path));
    render(<StorageConfigurationPage />); await openEncryption(); await screen.findByRole("heading", { name: "Read only" });
    expect(screen.queryByRole("button", { name: /Credential encryption|Update encryption/ })).toBeNull();
    const count = network.mock.calls.length; await act(async () => { await Promise.resolve(); });
    expect(network).toHaveBeenCalledTimes(count);
  });

  it("aborts an in-flight update on unmount while retaining its identifier for reconciliation", async () => {
    let input!: ReenvelopeStorageCredentialInput, updateSignal: AbortSignal | undefined, resolve!: (response: Response) => void;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { input = JSON.parse(String(options.body)); updateSignal = options.signal as AbortSignal;
        return new Promise<Response>(done => { resolve = done; }); }
      return fallback(path);
    });
    const mounted = render(<StorageConfigurationPage />); await openEncryption(); fireEvent.click(await readyUpdate());
    await waitFor(() => expect(posts()).toHaveLength(1)); mounted.unmount();
    expect(updateSignal?.aborted).toBe(true); expect(JSON.parse(sessionStorage.getItem(intentKey)!)).toEqual(input);
    const count = network.mock.calls.length; await act(async () => resolve(json(receipt(input))));
    expect(network).toHaveBeenCalledTimes(count); expect(sessionStorage.getItem(intentKey)).not.toBeNull();
  });

  it("keeps older revision reconciliation separate after a candidate edit aborts the original request", async () => {
    let input!: ReenvelopeStorageCredentialInput, updateSignal: AbortSignal | undefined, resolve!: (response: Response) => void, edited = false;
    network.mockImplementation(async (path, options) => {
      if (options?.method === "POST") { input = JSON.parse(String(options.body)); updateSignal = options.signal as AbortSignal;
        return new Promise<Response>(done => { resolve = done; }); }
      if (options?.method === "PUT") { edited = true; return json(candidate()); }
      if (String(path).includes("/credential-reenvelopes/")) return json(receipt(input));
      if (String(path).includes("/credential-envelopes?")) return envelopeList(edited ? [envelope({ revision: 3, credentialRef: "opaque-new" }),
        envelope({ isCurrentCandidate: false, status: "current" })] : [envelope()]);
      if (String(path).endsWith("/configuration")) return json(configuration({ ...candidate(), revision: edited ? 3 : 2 }));
      return fallback(path);
    });
    render(<StorageConfigurationPage />); await openEncryption(); fireEvent.click(await readyUpdate());
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Edit Research archive" })); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Current candidate credential revision 3"); await screen.findByText("Credential encryption updated for revision 2.");
    expect(updateSignal?.aborted).toBe(true); expect(sessionStorage.length).toBe(0); expect(posts()).toHaveLength(1);
    await act(async () => resolve(json(receipt(input))));
    expect(screen.getByText("Current candidate credential revision 3")).toBeTruthy(); expect(screen.getByText("Historical credential revision 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Update encryption for revision 3" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables a previous encryption action when the latest metadata read fails", async () => {
    let unavailable = false;
    network.mockImplementation(async path => String(path).includes("/credential-envelopes?") && unavailable ? json({}, 503) : fallback(path));
    render(<StorageConfigurationPage />); await openEncryption(); const update = await readyUpdate();
    unavailable = true; fireEvent.click(screen.getByRole("button", { name: "Refresh encryption status" }));
    await screen.findByText("Credential encryption status is unavailable. Refresh encryption status to try again.");
    expect((update as HTMLButtonElement).disabled).toBe(true); fireEvent.click(update); expect(posts()).toHaveLength(0);
    unavailable = false; fireEvent.click(screen.getByRole("button", { name: "Refresh encryption status" }));
    await waitFor(() => expect((update as HTMLButtonElement).disabled).toBe(false));
  });
});
