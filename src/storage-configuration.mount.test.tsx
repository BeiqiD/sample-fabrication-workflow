import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageCandidate, StorageConfigurationStatus } from "../shared/contracts/storage-configuration";
import { StorageConfigurationPage } from "./pages/StorageConfigurationPage";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const candidate = (): StorageCandidate => ({ profileId: "candidate-example", revision: 1, label: "Research archive",
  namespace: { kind: "s3", endpoint: "https://objects.example.org", bucket: "research-files", region: "us-east-1", root: "work", forcePathStyle: true },
  credentials: { status: "configured", ref: "opaque-reference" }, createdAt: "2026-10-01T14:00:00.000Z", createdBy: "admin@example.org" });
const configuration = (editing = true, items: StorageCandidate[] = []): StorageConfigurationStatus => ({ scope: "system", credentialEditingAvailable: editing, candidates: { items, hasMore: false } });
const network = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", network); network.mockReset();
  network.mockImplementation(async path => String(path).endsWith("/capability")
    ? json({ canManage: true, credentialEditingAvailable: true }) : json(configuration()));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const enter = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function fillS3() {
  await screen.findByRole("heading", { name: "New candidate" });
  enter("Name", "Research archive"); enter("HTTPS endpoint", "https://objects.example.org"); enter("Bucket", "research-files"); enter("Region", "us-east-1"); enter("Root folder", "work");
  enter("Access key ID", "private-key-id"); enter("Secret access key", "private-secret");
}
const saveCalls = () => network.mock.calls.filter(([, options]) => options?.method === "PUT");

describe("administrator storage candidate Settings", () => {
  it("keeps an unconfigured administrator policy read only without requesting candidate metadata", async () => {
    network.mockResolvedValue(json({ canManage: false, credentialEditingAvailable: false }));
    render(<StorageConfigurationPage />); await screen.findByRole("heading", { name: "Read only" });
    expect(screen.getByText(/Current Cloudflare R2 storage does not require external credentials/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(network).toHaveBeenCalledTimes(1); expect(network.mock.calls[0][0]).toBe("/api/storage/configuration/capability");
  });

  it("shows unavailable encrypted credentials as status and preserves native R2 without requiring a key", async () => {
    const item = candidate(); item.credentials.status = "unavailable";
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: false }) : json(configuration(false, [item])));
    render(<StorageConfigurationPage />); await screen.findByText("Research archive");
    expect(screen.getByText("Unavailable")).toBeTruthy(); expect(screen.getByText(/Current Cloudflare R2 storage does not require external credentials/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(document.body.textContent).not.toContain("opaque-reference"); expect(document.body.textContent).not.toContain("admin@example.org");
  });

  it("saves an S3 candidate as a draft, clears credential fields and never tests or activates storage", async () => {
    network.mockImplementation(async (path, options) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : options?.method === "PUT" ? json(candidate()) : json(configuration(true, saveCalls().length ? [candidate()] : [])));
    render(<StorageConfigurationPage />); await fillS3();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
    expect(saveCalls()).toHaveLength(1);
    expect(JSON.parse(String(saveCalls()[0][1]?.body))).toEqual({ expectedRevision: null, label: "Research archive", namespace: candidate().namespace,
      credentials: { mode: "replace", value: { accessKeyId: "private-key-id", secretAccessKey: "private-secret" } } });
    expect((screen.getByLabelText("Secret access key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Access key ID") as HTMLInputElement).value).toBe("");
    expect(localStorage.length).toBe(0);
    expect(network.mock.calls.every(([path]) => String(path).startsWith("/api/storage/configuration"))).toBe(true);
    expect(screen.queryByRole("button", { name: /test|activate/i })).toBeNull();
  });

  it("edits an immutable candidate by expected revision and retains its encrypted credentials", async () => {
    network.mockImplementation(async (path, options) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : options?.method === "PUT" ? json({ ...candidate(), revision: 2 }) : json(configuration(true, [candidate()])));
    render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Edit Research archive" }));
    expect((screen.getByLabelText("HTTPS endpoint") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Bucket") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Secret access key")).toBeNull();
    enter("Name", "Archive renamed"); enter("Region", "eu-west-1");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
    expect(JSON.parse(String(saveCalls()[0][1]?.body))).toMatchObject({ profileId: "candidate-example", expectedRevision: 1, label: "Archive renamed",
      namespace: { region: "eu-west-1" }, credentials: { mode: "retain" } });
  });

  it("does not replay a lost save response, clears secrets and requires a refresh to resume editing", async () => {
    network.mockImplementation(async (path, options) => {
      if (options?.method === "PUT") throw new Error("private-secret provider-failure");
      return String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true }) : json(configuration());
    });
    render(<StorageConfigurationPage />); await fillS3(); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("The save result is unavailable. Refresh saved candidates before trying again.");
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Secret access key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("private-secret");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" })); expect(saveCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false));
    expect(saveCalls()).toHaveLength(1);
  });

  it("saves WebDAV credentials without rendering or persisting the password", async () => {
    render(<StorageConfigurationPage />); await screen.findByRole("heading", { name: "New candidate" });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "webdav" } });
    enter("Name", "DAV archive"); enter("HTTPS endpoint", "https://dav.example.org/files"); enter("Username", "private-user"); enter("Password", "private-password");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
    expect(JSON.parse(String(saveCalls()[0][1]?.body))).toMatchObject({ namespace: { kind: "webdav", endpoint: "https://dav.example.org/files", root: "" }, credentials: { mode: "replace", value: { username: "private-user", password: "private-password" } } });
    expect(document.body.textContent).not.toContain("private-password"); expect(localStorage.length).toBe(0);
  });
});
