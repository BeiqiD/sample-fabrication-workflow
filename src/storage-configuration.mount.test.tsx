import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageCandidateCheck } from "../shared/contracts/storage-candidate-check";
import type { StorageCandidate, StorageConfigurationStatus } from "../shared/contracts/storage-configuration";
import { StorageConfigurationPage } from "./pages/StorageConfigurationPage";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const candidate = (): StorageCandidate => ({ profileId: "candidate-example", revision: 1, label: "Research archive",
  namespace: { kind: "s3", endpoint: "https://objects.example.org", bucket: "research-files", region: "us-east-1", root: "work", forcePathStyle: true },
  credentials: { status: "configured", ref: "opaque-reference" }, createdAt: "2026-10-01T14:00:00.000Z", createdBy: "admin@example.org" });
const awsCandidate = (expectedBucketOwner = "123456789012"): StorageCandidate => {
  const item = candidate();
  if (item.namespace.kind !== "s3") throw new Error("Expected S3 fixture");
  return { ...item, namespace: { ...item.namespace, endpoint: "https://s3.us-east-1.amazonaws.com", expectedBucketOwner } };
};
const configuration = (editing = true, items: StorageCandidate[] = []): StorageConfigurationStatus => ({ scope: "system", credentialEditingAvailable: editing, candidates: { items, hasMore: false } });
const checkId = "0f5f7a34-5532-4463-bf51-8c5eb9537f63";
const check = (changes: Partial<StorageCandidateCheck> = {}): StorageCandidateCheck => ({ id: checkId, profileId: "candidate-example", revision: 1,
  status: "succeeded", write: "passed", read: "passed", metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: null,
  createdAt: "2026-10-02T08:00:00.000Z", updatedAt: "2026-10-02T08:00:01.000Z", completedAt: "2026-10-02T08:00:01.000Z", ...changes });
const checkList = (items: StorageCandidateCheck[] = []) => json({ items, hasMore: false });
const network = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", network); network.mockReset();
  network.mockImplementation(async path => String(path).endsWith("/capability")
    ? json({ canManage: true, credentialEditingAvailable: true }) : String(path).includes("/checks?") ? json({ items: [], hasMore: false }) : json(configuration()));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
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
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: false }) : String(path).includes("/checks?") ? json({ items: [], hasMore: false }) : json(configuration(false, [item])));
    render(<StorageConfigurationPage />); await screen.findByText("Research archive");
    expect(screen.getByText("Unavailable")).toBeTruthy(); expect(screen.getByText(/Current Cloudflare R2 storage does not require external credentials/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(document.body.textContent).not.toContain("opaque-reference"); expect(document.body.textContent).not.toContain("admin@example.org");
  });

  it("saves an S3 candidate as a draft, clears credential fields and never tests or activates storage", async () => {
    network.mockImplementation(async (path, options) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : options?.method === "PUT" ? json(candidate()) : String(path).includes("/checks?") ? json({ items: [], hasMore: false }) : json(configuration(true, saveCalls().length ? [candidate()] : [])));
    render(<StorageConfigurationPage />); await fillS3();
    expect(screen.queryByLabelText("Expected AWS bucket owner (optional)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
    expect(saveCalls()).toHaveLength(1);
    expect(JSON.parse(String(saveCalls()[0][1]?.body))).toEqual({ expectedRevision: null, label: "Research archive", namespace: candidate().namespace,
      credentials: { mode: "replace", value: { accessKeyId: "private-key-id", secretAccessKey: "private-secret" } } });
    expect((screen.getByLabelText("Secret access key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Access key ID") as HTMLInputElement).value).toBe("");
    expect(localStorage.length).toBe(0);
    expect(network.mock.calls.every(([path]) => String(path).startsWith("/api/storage/configuration"))).toBe(true);
    expect(network.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
  });

  it("saves an optional 12-digit owner for an AWS S3 candidate without running a connection test", async () => {
    network.mockImplementation(async (path, options) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : options?.method === "PUT" ? json(awsCandidate()) : String(path).includes("/checks?") ? checkList() : json(configuration(true, saveCalls().length ? [awsCandidate()] : [])));
    render(<StorageConfigurationPage />); await fillS3(); enter("HTTPS endpoint", "https://s3.us-east-1.amazonaws.com");
    enter("Expected AWS bucket owner (optional)", "123"); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(saveCalls()).toHaveLength(0);
    enter("Expected AWS bucket owner (optional)", "123456789012"); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
    expect(JSON.parse(String(saveCalls()[0][1]?.body))).toMatchObject({ expectedRevision: null, namespace: awsCandidate().namespace });
    expect(network.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
  });

  it("keeps an entered owner visible after switching to generic S3 and requires clearing it before saving", async () => {
    render(<StorageConfigurationPage />); await fillS3(); enter("HTTPS endpoint", "https://s3.us-east-1.amazonaws.com");
    enter("Expected AWS bucket owner (optional)", "123456789012"); enter("HTTPS endpoint", "https://objects.example.org");
    expect((screen.getByLabelText("Expected AWS bucket owner (optional)") as HTMLInputElement).value).toBe("123456789012");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Expected AWS bucket owner requires a matching AWS S3 endpoint and region. Correct them or clear the owner.");
    expect(saveCalls()).toHaveLength(0);
    enter("Expected AWS bucket owner (optional)", ""); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
    expect(JSON.parse(String(saveCalls()[0][1]?.body)).namespace).toEqual(candidate().namespace);
  });

  for (const keepOwner of [true, false]) {
    it(`${keepOwner ? "retains" : "omits a cleared"} expected owner when saving an AWS candidate revision`, async () => {
      network.mockImplementation(async (path, options) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
        : options?.method === "PUT" ? json({ ...awsCandidate(), revision: 2 }) : String(path).includes("/checks?") ? checkList() : json(configuration(true, [awsCandidate()])));
      render(<StorageConfigurationPage />); fireEvent.click(await screen.findByRole("button", { name: "Edit Research archive" }));
      const owner = screen.getByLabelText("Expected AWS bucket owner (optional)") as HTMLInputElement;
      expect(owner.value).toBe("123456789012"); expect(owner.disabled).toBe(false);
      if (!keepOwner) enter("Expected AWS bucket owner (optional)", "");
      enter("Name", "Archive renamed"); fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      await screen.findByText("Candidate saved as a draft. Current upload destinations are unchanged.");
      const input = JSON.parse(String(saveCalls()[0][1]?.body));
      expect(input).toMatchObject({ expectedRevision: 1, label: "Archive renamed", credentials: { mode: "retain" } });
      if (keepOwner) expect(input.namespace.expectedBucketOwner).toBe("123456789012");
      else expect(input.namespace).not.toHaveProperty("expectedBucketOwner");
    });
  }

  it("clears matching check evidence when revising the expected owner and marks the earlier test historical", async () => {
    let item = awsCandidate(), completeSave!: () => void;
    const positive = "Recorded success matches the current configuration and stored credential version.";
    const negative = "No recorded success matches the current configuration and stored credential version.";
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (options?.method === "PUT") return new Promise<Response>(resolve => {
        completeSave = () => { item = { ...awsCandidate("210987654321"), revision: 2 }; resolve(json(item)); };
      });
      if (String(path).includes("/checks?")) return checkList([check()]);
      if (String(path).includes("/readiness?")) return json({ profileId: item.profileId, revision: item.revision,
        observedAt: "2026-10-02T10:00:00.000Z", credential: { envelopeRevision: 1, status: "current" }, evidence: {
          currentConfigurationSuccessCount: item.revision === 1 ? 1 : 0, historicalConfigurationSuccessCount: item.revision === 1 ? 0 : 1,
          exactCurrentContextSuccess: item.revision === 1 ? { checkId, completedAt: check().completedAt } : null,
          inProgressCount: 0, unresolvedCleanupCount: 0 }, canActivate: false });
      return json(configuration(true, [item]));
    });
    render(<StorageConfigurationPage />); await screen.findByText("Current configuration revision 1");
    fireEvent.click(screen.getByRole("button", { name: "Check evidence for Research archive" })); await screen.findByText(positive);
    fireEvent.click(screen.getByRole("button", { name: "Edit Research archive" })); enter("Expected AWS bucket owner (optional)", "210987654321");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(screen.queryByText(positive)).toBeNull();
    expect(JSON.parse(String(saveCalls()[0][1]?.body))).toMatchObject({ expectedRevision: 1, namespace: { expectedBucketOwner: "210987654321" } });
    await act(async () => completeSave()); await screen.findByText("Historical revision 1");
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh evidence" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" })); await screen.findByText(negative);
    expect(screen.queryByText(positive)).toBeNull();
    expect(network.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(screen.queryByRole("button", { name: /activate/i })).toBeNull();
  });

  it("edits an immutable candidate by expected revision and retains its encrypted credentials", async () => {
    network.mockImplementation(async (path, options) => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : options?.method === "PUT" ? json({ ...candidate(), revision: 2 }) : String(path).includes("/checks?") ? json({ items: [], hasMore: false }) : json(configuration(true, [candidate()])));
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

  it("loads test history on reload and marks old results as historical without qualifying a new revision", async () => {
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : String(path).includes("/checks?") ? checkList([check()]) : json(configuration(true, [{ ...candidate(), revision: 2 }])));
    render(<StorageConfigurationPage />); await screen.findByText("Historical revision 1");
    expect(screen.getByText("This result does not test the current candidate revision.")).toBeTruthy();
    expect(screen.queryByText("Current revision 2")).toBeNull();
    expect((screen.getByRole("button", { name: "Test Research archive" }) as HTMLButtonElement).disabled).toBe(false);
    expect(network.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("captures the exact candidate revision and test ID before starting, then reads its recorded result", async () => {
    let started = false;
    const running = check({ status: "running", read: "pending", metadata: "pending", delete: "pending", cleanup: "pending", completedAt: null });
    let submitted: { checkId: string; profileId: string; expectedRevision: number };
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (options?.method === "POST") {
        submitted = JSON.parse(String(options.body));
        expect(JSON.parse(sessionStorage.getItem("storage-candidate-check:candidate-example")!)).toEqual(submitted);
        started = true; return json({ ...running, id: submitted.checkId });
      }
      if (String(path).includes("/checks?")) return checkList(started ? [{ ...check(), id: submitted.checkId }] : []);
      return json(configuration(true, [candidate()]));
    });
    render(<StorageConfigurationPage />);
    const start = await screen.findByRole("button", { name: "Test Research archive" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(start);
    await screen.findByText("Running");
    expect(submitted!).toMatchObject({ profileId: "candidate-example", expectedRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Check test status for Research archive" }));
    await screen.findByText("Removal confirmed");
    expect(sessionStorage.length).toBe(0);
    expect(network.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(saveCalls()).toHaveLength(0);
  });

  it("reconciles a lost POST response with GET and never replays the write", async () => {
    let submittedId = "";
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (options?.method === "POST") { submittedId = JSON.parse(String(options.body)).checkId; throw new Error("private-provider-message"); }
      if (String(path).includes("/checks?")) return checkList();
      if (String(path).includes("/checks/")) return json(check({ id: submittedId }));
      return json(configuration(true, [candidate()]));
    });
    render(<StorageConfigurationPage />);
    const start = await screen.findByRole("button", { name: "Test Research archive" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(start);
    await screen.findByText("Removal confirmed");
    expect(network.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(network.mock.calls.some(([path, options]) => path === `/api/storage/configuration/checks/${submittedId}` && options?.method === "GET")).toBe(true);
    expect(document.body.textContent).not.toContain("private-provider-message"); expect(sessionStorage.length).toBe(0);
  });

  it("retains a lost test ID across reload when GET returns 404 and blocks a replacement write", async () => {
    let submittedId = "";
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (options?.method === "POST") { submittedId = JSON.parse(String(options.body)).checkId; throw new Error("lost response"); }
      if (String(path).includes("/checks?")) return checkList();
      if (String(path).includes("/checks/")) return json({ error: "Not found" }, 404);
      return json(configuration(true, [candidate()]));
    });
    const first = render(<StorageConfigurationPage />);
    const start = await screen.findByRole("button", { name: "Test Research archive" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(start);
    await screen.findByText(/The test result is not available yet/);
    expect(JSON.parse(sessionStorage.getItem("storage-candidate-check:candidate-example")!)).toEqual({ checkId: submittedId, profileId: "candidate-example", expectedRevision: 1 });
    first.unmount(); render(<StorageConfigurationPage />);
    await screen.findByText(/The test result is not available yet/);
    expect((screen.getByRole("button", { name: "Test Research archive" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check test status for Research archive" }));
    await screen.findByText(/The test result is not available yet/);
    expect(network.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(localStorage.length).toBe(0);
  });

  it("cleans only the recorded object with unavailable current credentials and retains interrupted-write uncertainty", async () => {
    const interrupted = check({ status: "interrupted", write: "unknown", read: "not_run", metadata: "not_run", delete: "not_run", cleanup: "required", code: "execution_interrupted" });
    const item = candidate(); item.credentials.status = "unavailable";
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (String(path).includes("/checks?")) return checkList([interrupted]);
      if (options?.method === "POST") throw new Error("lost cleanup response");
      if (String(path).includes("/checks/")) return json({ ...interrupted, delete: "passed", cleanup: "absence_observed" });
      return json(configuration(true, [item]));
    });
    render(<StorageConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Clean up test object for revision 1" }));
    await screen.findByText("Not found; removal unconfirmed");
    const posts = network.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(posts).toHaveLength(1); expect(posts[0][0]).toBe(`/api/storage/configuration/checks/${checkId}/cleanup`);
    expect(posts[0][1]?.body).toBe("{}"); expect(screen.queryByRole("button", { name: "Test Research archive" })).toBeNull();
    expect(screen.getByText("An interrupted write may still finish later. Removal remains unconfirmed.")).toBeTruthy();
  });

  it("allows an independent new test after a terminal uncertain result while preserving its warning", async () => {
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : String(path).includes("/checks?") ? checkList([check({ status: "interrupted", write: "unknown", cleanup: "absence_observed", code: "execution_interrupted" })]) : json(configuration(true, [candidate()])));
    render(<StorageConfigurationPage />); await screen.findByText("Not found; removal unconfirmed");
    expect((screen.getByRole("button", { name: "Test Research archive" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/A new test uses a separate temporary object/)).toBeTruthy();
  });

  it("describes an unconfirmed delete after an acknowledged write without claiming the write was interrupted", async () => {
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : String(path).includes("/checks?") ? checkList([check({ status: "failed", delete: "unknown", cleanup: "absence_observed", code: "cleanup_unconfirmed" })]) : json(configuration(true, [candidate()])));
    render(<StorageConfigurationPage />); await screen.findByText("The object was absent when checked, but removal is not confirmed.");
    expect(screen.queryByText(/An interrupted write may still finish later/)).toBeNull();
    expect((screen.getByRole("button", { name: "Test Research archive" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("retains an unresolved test ID when a recorded result has a different revision", async () => {
    sessionStorage.setItem("storage-candidate-check:candidate-example", JSON.stringify({ checkId, profileId: "candidate-example", expectedRevision: 1 }));
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : String(path).includes("/checks?") ? checkList([check({ revision: 2 })]) : json(configuration(true, [candidate()])));
    render(<StorageConfigurationPage />); await screen.findByText("Test history is unavailable. Check its status before starting a test.");
    expect((screen.getByRole("button", { name: "Test Research archive" }) as HTMLButtonElement).disabled).toBe(true);
    expect(sessionStorage.getItem("storage-candidate-check:candidate-example")).toContain(checkId);
    expect(screen.queryByText("Historical revision 2")).toBeNull();
    expect(network.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("aborts checks and hides administrator controls after a 403 without further polling", async () => {
    let historyReads = 0;
    network.mockImplementation(async path => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (String(path).includes("/checks?")) return ++historyReads === 1
        ? checkList([check({ status: "running", read: "pending", metadata: "pending", delete: "pending", cleanup: "pending", completedAt: null })]) : json({}, 403);
      return json(configuration(true, [candidate()]));
    });
    render(<StorageConfigurationPage />); await screen.findByText("Running"); vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Check test status for Research archive" }));
    await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Read only" })).toBeTruthy());
    const count = network.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
    expect(network).toHaveBeenCalledTimes(count); expect(screen.queryByRole("button", { name: /Test Research|Clean up/ })).toBeNull();
  });

  it("reconciles a pending earlier revision and restores controls after a candidate revision changes", async () => {
    let newRevision = false, submittedId = "", resolveStart!: (response: Response) => void, startSignal: AbortSignal | undefined;
    network.mockImplementation(async (path, options) => {
      if (String(path).endsWith("/capability")) return json({ canManage: true, credentialEditingAvailable: true });
      if (options?.method === "POST") {
        submittedId = JSON.parse(String(options.body)).checkId; startSignal = options.signal as AbortSignal;
        return new Promise<Response>(resolve => { resolveStart = resolve; });
      }
      if (options?.method === "PUT") { newRevision = true; return json({ ...candidate(), revision: 2 }); }
      if (String(path).includes("/checks?")) return checkList(newRevision ? [check({ id: submittedId })] : []);
      return json(configuration(true, [{ ...candidate(), revision: newRevision ? 2 : 1 }]));
    });
    render(<StorageConfigurationPage />);
    const start = await screen.findByRole("button", { name: "Test Research archive" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(start);
    await waitFor(() => expect(submittedId).not.toBe(""));
    fireEvent.click(screen.getByRole("button", { name: "Edit Research archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Historical revision 1");
    expect(startSignal?.aborted).toBe(true);
    await waitFor(() => expect((screen.getByRole("button", { name: "Test Research archive" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => resolveStart(json(check({ id: submittedId, status: "running", cleanup: "pending", completedAt: null }))));
    expect(screen.getByText("Historical revision 1")).toBeTruthy(); expect(sessionStorage.length).toBe(0);
  });

  it("bounds automatic status polling without starting another provider write", async () => {
    const running = check({ status: "running", read: "pending", metadata: "pending", delete: "pending", cleanup: "pending", completedAt: null });
    network.mockImplementation(async path => String(path).endsWith("/capability") ? json({ canManage: true, credentialEditingAvailable: true })
      : String(path).includes("/checks?") ? checkList([running]) : String(path).includes("/checks/") ? json(running) : json(configuration(true, [candidate()])));
    vi.useFakeTimers(); render(<StorageConfigurationPage />);
    await vi.waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    for (let attempt = 0; attempt < 10; attempt += 1) await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("The test is still running. Check its status for the latest result.")).toBeTruthy();
    const count = network.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(network).toHaveBeenCalledTimes(count);
    expect(network.mock.calls.filter(([path]) => String(path).includes("/checks/"))).toHaveLength(10);
    expect(network.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });
});
