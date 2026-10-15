import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEvidencePage } from "./pages/FileEvidencePage";

const key = (id = "reference-a") => ({ consumerKind: "project_content_attachment", consumerId: id, consumerSubId: "", fileSlot: "primary" });
const label = (id = "reference-a") => ({ projectId: `project-${id}`, projectTitle: `Project ${id}`, attachmentName: `${id}.png` });
const row = (id = "reference-a") => ({ consumer_kind: "project_content_attachment", consumer_id: id, consumer_sub_id: "", file_slot: "primary", generation: 1, occurrence_id: `occurrence-${id}`, state: "pending", identification: label(id) });
const review = (id = "reference-a") => ({ version: 1, kind: "file-shadow-evidence-review", readOnly: true, bytesVerified: false,
  key: key(id), head: { generation: 1, occurrenceId: `occurrence-${id}`, sourceMetadataSha256: "a".repeat(64) },
  baselineSha256: "b".repeat(64), status: "ambiguous", reasons: ["consumer_purpose_unresolved", "namespace_evidence_missing"],
  identification: label(id), purpose: null, expectedBytes: 871, expectedSha256: "c".repeat(64), sourceProvider: "r2", sourceProfile: null,
  peerReferences: [] as Array<{ key: ReturnType<typeof key>; purpose: null }> });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const network = vi.fn<typeof fetch>();
let listHandler: () => unknown | Promise<unknown>;
let reviewHandler: (id: string) => unknown | Promise<unknown>;
beforeEach(() => {
  network.mockReset(); localStorage.clear();
  listHandler = () => ({ records: [row(), row("reference-b"), { ...row("other-kind"), consumer_kind: "comment_submission_item", identification: null }], nextCursor: null });
  reviewHandler = (id) => review(id);
  network.mockImplementation(async (input, init) => {
    const path = new URL(String(input), "https://app.example").pathname;
    let value: unknown;
    if (path === "/api/files/shadow/evidence/capabilities") value = { canAdjudicate: false };
    else if (path === "/api/files/shadow/consumers" && init?.method === undefined) value = await listHandler();
    else if (path === "/api/files/shadow/evidence-review" && init?.method === "POST") value = await reviewHandler(JSON.parse(String(init.body)).key.consumerId);
    else throw new Error(`Unexpected endpoint ${path}`);
    return value instanceof Response ? value : json(value);
  });
  vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const inspectName = (id = "reference-a") => `Inspect evidence ${JSON.stringify(id)} ""`;
async function mount(strict = false) {
  const result = render(strict ? <StrictMode><FileEvidencePage /></StrictMode> : <FileEvidencePage />);
  await screen.findByRole("button", { name: inspectName() }); return result;
}
async function inspect(id = "reference-a") { await act(async () => { fireEvent.click(screen.getByRole("button", { name: inspectName(id) })); }); }

describe("historical file evidence page", () => {
  it("reads only the list and operator capability on StrictMode mount and never accesses the conversion journal", async () => {
    const journal = "preserved unknown operation";
    localStorage.setItem("file-shadow-pilot-operation-v1", journal);
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    await mount(true);
    expect(network.mock.calls.every(([path]) => (String(path).startsWith("/api/files/shadow/consumers?") || String(path).endsWith("/evidence/capabilities")))).toBe(true);
    expect(screen.queryByRole("button", { name: /other-kind/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /convert|pause|resume|save|admit|withdraw/i })).toBeNull();
    await inspect();
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem("file-shadow-pilot-operation-v1")).toBe(journal);
    expect(network.mock.calls.every(([path]) => /\/api\/files\/shadow\/(consumers\?|evidence-review$|evidence\/capabilities$)/.test(String(path)))).toBe(true);
  });

  it("shows fresh labels, human evidence gaps and recorded expectations without treating them as verified bytes", async () => {
    const value = review(); value.identification.attachmentName = "Updated attachment.png";
    reviewHandler = () => value;
    await mount(); await inspect();
    const detail = screen.getByRole("region", { name: "Selected evidence" });
    expect(within(detail).getByText("Updated attachment.png")).toBeTruthy();
    expect(within(detail).getByText(/Purpose is unresolved:/)).toBeTruthy();
    expect(within(detail).getByText(/Original storage is unresolved:/)).toBeTruthy();
    expect(within(detail).getByText(/has not downloaded or verified the source bytes/)).toBeTruthy();
    expect(within(detail).getByText("871")).toBeTruthy();
    expect(within(detail).getByText("c".repeat(64))).toBeTruthy();
    const summary = within(detail).getByText("Exact reference and snapshot");
    expect(summary.parentElement?.hasAttribute("open")).toBe(false);
    fireEvent.click(summary);
    expect(within(detail).getByText('""')).toBeTruthy();
    expect(within(detail).getByText("occurrence-reference-a")).toBeTruthy();
    expect(within(detail).getByText("b".repeat(64))).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps a newer selection when an earlier read resolves or fails later", async () => {
    const old = deferred<unknown>();
    reviewHandler = (id) => id === "reference-a" ? old.promise : review(id);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: inspectName() }));
    await inspect("reference-b");
    await act(async () => { old.resolve(review()); });
    const detail = screen.getByRole("region", { name: "Selected evidence" });
    expect(within(detail).getByText("reference-b.png")).toBeTruthy();
    expect(within(detail).queryByText("reference-a.png")).toBeNull();
    const failing = deferred<unknown>();
    reviewHandler = (id) => id === "reference-a" ? failing.promise : review(id);
    fireEvent.click(screen.getByRole("button", { name: inspectName() }));
    await inspect("reference-b");
    await act(async () => { failing.reject(new Error("PRIVATE SERVER ERROR")); });
    expect(within(detail).getByText("reference-b.png")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("invalidates pending detail when refreshing the list and reads no details automatically", async () => {
    const old = deferred<unknown>(); reviewHandler = () => old.promise;
    await mount(); fireEvent.click(screen.getByRole("button", { name: inspectName() }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh list" })); });
    await act(async () => { old.resolve(review()); });
    expect(screen.getByText("Choose an attachment to review its recorded evidence.")).toBeTruthy();
    expect(network.mock.calls.filter(([path]) => String(path).endsWith("evidence-review"))).toHaveLength(1);
  });

  it("reviews a same-locator peer independently using its own list labels and fresh request", async () => {
    reviewHandler = (id) => id === "reference-a" ? { ...review(), peerReferences: [{ key: key("reference-b"), purpose: null }] } : review(id);
    await mount(); await inspect();
    const detail = screen.getByRole("region", { name: "Selected evidence" });
    expect(within(detail).getByText("reference-b.png")).toBeTruthy();
    expect(within(detail).getByText("Project reference-b")).toBeTruthy();
    await act(async () => { fireEvent.click(within(detail).getByRole("button", { name: "Inspect this related reference" })); });
    expect(within(detail).getByText("occurrence-reference-b")).toBeTruthy();
    expect(network.mock.calls.filter(([path]) => String(path).endsWith("evidence-review")).map(([, init]) => JSON.parse(String(init?.body)).key.consumerId)).toEqual(["reference-a", "reference-b"]);
  });

  it("requires explicit pagination when a page contains only other consumer kinds", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ ...row(`other-${index}`), consumer_kind: "comment_submission_item", identification: null }));
    listHandler = () => ({ records: rows, nextCursor: { ...key("other-19"), consumerKind: "comment_submission_item" } });
    render(<FileEvidencePage />);
    await screen.findByText("No Project attachments on this page. Continue to the next page.");
    expect(network.mock.calls.filter(([path]) => String(path).includes("/consumers?"))).toHaveLength(1);
    listHandler = () => ({ records: [row()], nextCursor: null });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next page" })); });
    expect(screen.getByRole("button", { name: inspectName() })).toBeTruthy();
    expect(network.mock.calls.every(([path]) => String(path).includes("/consumers?") || String(path).endsWith("/evidence/capabilities"))).toBe(true);
    expect(String(network.mock.calls.filter(([path]) => String(path).includes("/consumers?"))[1][0])).toContain("after=");
  });

  it("clears old evidence on read error and renders only a fixed error", async () => {
    await mount(); await inspect();
    reviewHandler = () => json({ error: "PRIVATE_STORAGE_KEY" }, 403);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reread evidence" })); });
    expect(screen.getByRole("alert").textContent).toContain("Access is unavailable");
    expect(document.body.textContent).not.toContain("PRIVATE_STORAGE_KEY");
    expect(screen.queryByText("c".repeat(64))).toBeNull();
  });

  it("renders untrusted identification as plain text and supports an empty list", async () => {
    const value = review(); value.identification.attachmentName = '<img src="https://private.invalid" onerror="alert(1)">';
    reviewHandler = () => value;
    await mount(); await inspect();
    expect(screen.getByText(value.identification.attachmentName)).toBeTruthy();
    expect(document.querySelector(".evidence-identification img")).toBeNull();
    listHandler = () => ({ records: [], nextCursor: null });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh list" })); });
    expect(screen.getByText("No current Project attachments on this page.")).toBeTruthy();
  });
});
