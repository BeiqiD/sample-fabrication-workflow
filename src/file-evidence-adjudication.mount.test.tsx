import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEvidenceAdjudication } from "./pages/FileEvidenceAdjudication";
import { FILE_SHADOW_ADJUDICATION_JOURNAL_KEY, FILE_SHADOW_REVOCATION_JOURNAL_KEY } from "./lib/file-shadow-adjudication-client";
import { shadowAdjudicationRequestSha256, shadowAdjudicationRevocationRequestSha256, type ShadowAdjudicationRequest, type ShadowAdjudicationRevocationRequest } from "../shared/contracts/file-shadow-adjudication";

const key = (id = "reference-a") => ({ consumerKind: "project_content_attachment" as const, consumerId: id, consumerSubId: "", fileSlot: "primary" as const });
const preconditions = { occurrenceId: "occurrence-a", generation: 1, sourceSha256: "a".repeat(64), sourceLocator: { storeKind: "r2" as const, provider: "r2" as const, objectKey: "source/a" }, expectedBaselineSha256: "b".repeat(64), expectedEpoch: 5, expectedIncarnation: null, supersedesId: null };
const preparation = (id = "reference-a") => ({ key: key(id), eligible: true, blockers: [] as string[], preconditions, profiles: [{ profileId: "original-r2", configurationRevision: 1 }], activeAdjudication: null as Awaited<ReturnType<typeof accepted>> | null, revocable: false, revocationBlockers: [] as string[] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function accepted(request: ShadowAdjudicationRequest, status: "accepted" | "withdrawn" = "accepted") {
  return { requestId: request.requestId, status, request, requestSha256: await shadowAdjudicationRequestSha256(request), createdBy: "operator", createdAt: "2026-09-28T12:00:00.000Z", revocation: null };
}
const original = (): ShadowAdjudicationRequest => ({ ...preconditions, requestId: "00000000-0000-4000-8000-000000000001", key: key(), purpose: "research_source", purposeStatement: "Explicit operator classification", namespaceStatement: "Original deployment record", evidenceReference: "September operational log", sourceProfile: { profileId: "original-r2", configurationRevision: 1 } });
let capability: boolean;
let prepareHandler: (id: string) => unknown | Promise<unknown>;
let actionHandler: (path: string, request: unknown) => Promise<Response>;
const network = vi.fn<typeof fetch>();
beforeEach(() => {
  localStorage.clear(); network.mockReset(); capability = true; prepareHandler = (id) => preparation(id);
  actionHandler = async (_path, request) => json(await accepted(request as ShadowAdjudicationRequest));
  network.mockImplementation(async (input, init) => {
    const path = String(input).replace("/api/files/shadow/evidence/", "");
    if (path === "capabilities") return json({ canAdjudicate: capability });
    const body = JSON.parse(String(init?.body));
    if (path === "prepare") return json(await prepareHandler(body.key.consumerId));
    return actionHandler(path, body);
  });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => unknown) => action({}) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const button = (name: string) => screen.getByRole("button", { name });
async function click(name: string) { await act(async () => { fireEvent.click(button(name)); }); await waitFor(() => expect(screen.getByRole("region", { name: "Operator evidence decision" }).getAttribute("aria-busy")).toBe("false")); }
async function fill() {
  await screen.findByRole("button", { name: "Record evidence decision" });
  fireEvent.change(screen.getByLabelText("Original storage profile"), { target: { value: "original-r2" } });
  fireEvent.change(screen.getByLabelText("Why retain this reference as a research source?"), { target: { value: "Explicit present-day purpose." } });
  fireEvent.change(screen.getByLabelText("What establishes the original storage location?"), { target: { value: "Operator-supplied binding record." } });
  fireEvent.change(screen.getByLabelText("Supporting record or source reference"), { target: { value: "Record number 2026-01." } });
  fireEvent.click(screen.getByLabelText("I reviewed this reference and supplied the purpose and original-storage basis separately."));
}

describe("operator evidence panel", () => {
  it("shows denied access and reads no journals or prepare endpoints for an ordinary viewer", async () => {
    capability = false;
    const get = vi.spyOn(Storage.prototype, "getItem"), set = vi.spyOn(Storage.prototype, "setItem");
    render(<FileEvidenceAdjudication selected={key()} />);
    await screen.findByText(/Operator access is unavailable/);
    expect(network).toHaveBeenCalledTimes(1); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "Record evidence decision" })).toBeNull();
  });

  it("requires separate empty statements and an explicit profile choice without sending a decision on read", async () => {
    render(<FileEvidenceAdjudication selected={key()} />);
    await screen.findByRole("button", { name: "Record evidence decision" });
    expect((screen.getByLabelText("Original storage profile") as HTMLSelectElement).value).toBe("");
    expect(screen.getAllByRole("textbox").every((element) => (element as HTMLTextAreaElement).value === "")).toBe(true);
    expect((button("Record evidence decision") as HTMLButtonElement).disabled).toBe(true);
    expect(network.mock.calls.map(([path]) => String(path).split("/").at(-1))).toEqual(["capabilities", "prepare"]);
    await fill(); await click("Record evidence decision");
    expect(screen.getByText("accepted")).toBeTruthy();
    expect(localStorage.getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY)).toContain("Explicit present-day purpose.");
    expect(network.mock.calls.some(([path]) => String(path).includes("convert"))).toBe(false);
  });

  it("keeps a lost request through a missing receipt and permits dismissal only after durable withdrawal", async () => {
    actionHandler = async () => { throw new Error("lost"); };
    render(<FileEvidenceAdjudication selected={key()} />); await fill(); await click("Record evidence decision");
    expect(screen.getByRole("alert").textContent).toContain("response was lost");
    const originalSaved = JSON.parse(localStorage.getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY)!).request;
    expect((button("Dismiss confirmed receipt") as HTMLButtonElement).disabled).toBe(true);
    actionHandler = async () => json({ error: "absent" }, 404); await click("Inspect saved receipt");
    expect(screen.getByRole("alert").textContent).toContain("No receipt is visible");
    expect(JSON.parse(localStorage.getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY)!).request).toEqual(originalSaved);
    actionHandler = async (path, request) => { expect(path).toBe("withdraw"); expect(request).toEqual(originalSaved); return json(await accepted(request as ShadowAdjudicationRequest, "withdrawn")); };
    await click("Withdraw unconfirmed request"); expect(screen.getByText("withdrawn")).toBeTruthy();
    await click("Dismiss confirmed receipt"); expect(localStorage.getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY)).toBeNull();
  });

  it("invalidates open forms when another tab changes the journal and when another reference is selected", async () => {
    const view = render(<FileEvidenceAdjudication selected={key()} />); await fill();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: FILE_SHADOW_ADJUDICATION_JOURNAL_KEY })));
    expect(screen.queryByRole("button", { name: "Record evidence decision" })).toBeNull();
    expect(screen.getByText(/changed in another tab/)).toBeTruthy();
    await click("Read decision prerequisites"); await fill();
    view.rerender(<FileEvidenceAdjudication selected={key("reference-b")} />);
    await waitFor(() => expect((screen.getByLabelText("Original storage profile") as HTMLSelectElement).value).toBe(""));
    expect(screen.getAllByRole("textbox").every((element) => (element as HTMLTextAreaElement).value === "")).toBe(true);
    expect(network.mock.calls.some(([path]) => String(path).endsWith("accept"))).toBe(false);
  });

  it("preserves rejected revocations separately and allows unrelated decisions while offering exact recovery", async () => {
    const receipt = await accepted(original());
    prepareHandler = (id) => id === "reference-a" ? { ...preparation(), eligible: false, activeAdjudication: receipt, revocable: true } : preparation(id);
    actionHandler = async () => json({ error: "conversion prevents revocation" }, 409);
    const view = render(<FileEvidenceAdjudication selected={key()} />);
    await screen.findByRole("button", { name: "Revoke decision" });
    expect((button("Revoke decision") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for revocation"), { target: { value: "Incorrect cited record." } });
    fireEvent.click(screen.getByLabelText("I intend to revoke this exact accepted decision.")); await click("Revoke decision");
    expect(screen.getByText("Saved revocation awaiting confirmation")).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(FILE_SHADOW_REVOCATION_JOURNAL_KEY)!).requests[0];
    expect((button("Dismiss confirmed revocation") as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem(FILE_SHADOW_ADJUDICATION_JOURNAL_KEY)).toBeNull();
    view.rerender(<FileEvidenceAdjudication selected={key("reference-b")} />); await fill();
    actionHandler = async (_path, request) => json(await accepted(request as ShadowAdjudicationRequest)); await click("Record evidence decision");
    expect(JSON.parse(localStorage.getItem(FILE_SHADOW_REVOCATION_JOURNAL_KEY)!).requests[0]).toEqual(saved);
    actionHandler = async (path, request) => {
      expect(path).toBe("revocation/request"); expect(request).toEqual(saved.revocationRequest);
      return json({ ...receipt, status: "revoked", revocation: { request, requestSha256: await shadowAdjudicationRevocationRequestSha256(request as ShadowAdjudicationRevocationRequest), createdBy: "other-operator", createdAt: "2026-09-28T12:05:00.000Z" } });
    };
    await click("Inspect revocation receipt"); expect(screen.getByText("Confirmed revocation")).toBeTruthy();
  });

  it("keeps known nonrevocable decisions disabled", async () => {
    const receipt = await accepted(original());
    prepareHandler = () => ({ ...preparation(), eligible: false, activeAdjudication: receipt, revocable: false, revocationBlockers: ["conversion_already_published"] });
    render(<FileEvidenceAdjudication selected={key()} />);
    await screen.findByText(/Revocation is currently unavailable/);
    expect((button("Revoke decision") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Reason for revocation") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
