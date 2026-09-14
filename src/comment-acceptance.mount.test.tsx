// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalCommentAcceptanceInput, type AcceptedCommentSubmissionInput } from "../shared/contracts/comment-acceptance";
import type { CommentSubmission } from "../shared/types";
import { commentUploadQueue } from "./lib/commentUploadQueue";
import { CommentComposer, CommentSubmissionRecovery } from "./components/CommentComposer";
import { api } from "./lib/api";
import { prepareCommentImage } from "./lib/images";
vi.mock("./lib/images", () => ({ prepareCommentImage: vi.fn(), isTiffFile: () => false }));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const context = (sampleId = "sample-a", expectedUpdatedAt = "2026-09-14T00:00:00.000Z") => ({ kind: "sample" as const, sampleId, expectedUpdatedAt });
async function state(input: AcceptedCommentSubmissionInput, status = "pending", itemStatus = "pending") {
  const canonical = await canonicalCommentAcceptanceInput(input);
  return { request: { submissionId: input.id, inputSha256: canonical.sha256, expiresAt: "2099-01-01T00:00:00.000Z", input: canonical.input, status,
    items: input.items.map((item) => ({ id: item.id, kind: item.kind, sha256: item.kind === "link" ? null : item.sha256, status: itemStatus })),
    ...(status === "ready" ? { result: { submissionId: input.id, completedAt: "2026-09-14T00:00:00.000Z", occurrenceIds: [], eventIds: ["11111111-1111-4111-8111-111111111111"], itemIds: input.items.map((item) => item.id) } } : {}),
  } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let xhrs: LostXHR[];
class LostXHR extends EventTarget {
  upload = new EventTarget(); headers: Record<string, string> = {}; body: unknown;
  open() {} setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) { this.body = body; xhrs.push(this); queueMicrotask(() => this.dispatchEvent(new Event("error"))); }
  abort() { this.dispatchEvent(new Event("abort")); }
}
beforeEach(() => {
  sessionStorage.clear(); xhrs = []; vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("XMLHttpRequest", LostXHR);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:comment-preview"); static revokeObjectURL = vi.fn(); });
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({ provider: null, available: false, authentication: "not_configured", message: "No managed attachments" });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
function typeAndSubmit(body = "Frozen note") { fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: body } }); fireEvent.click(screen.getByRole("button", { name: "Add note" })); }

describe("mounted immutable Comment acceptance", () => {
  it("keeps text and target revision frozen through a lost create, changed live context, and failed refresh", async () => {
    let input!: AcceptedCommentSubmissionInput; let ready = false; const operations: string[] = [];
    const refresh = vi.fn().mockRejectedValueOnce(new Error("Refresh unavailable")).mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/comment-submissions") { operations.push("create"); input = JSON.parse(String(init?.body)); throw new TypeError("lost create"); }
      if (String(path).endsWith("/acceptance")) { operations.push("status"); return json(await state(input, ready ? "ready" : "pending")); }
      if (String(path).endsWith("/finalize")) { operations.push("finalize"); ready = true; return json(await state(input, "ready")); }
      throw new Error(`Unexpected ${path}`);
    }));
    const view = render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    typeAndSubmit("Frozen **note** $x$");
    await screen.findByText("The comment response was lost. Retry to check the same request.");
    view.rerender(<CommentComposer label="Note" context={context("sample-a", "2026-09-15T00:00:00.000Z")} onSubmitted={refresh} submitLabel="Add note" />);
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "A different unsent note" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry incomplete" }));
    await screen.findByText("Refresh unavailable");
    expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).observedReady).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry incomplete" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Uploading comment…")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry incomplete" })).toBeNull(); expect(operations).toEqual(["create", "status", "status", "finalize", "status", "status"]);
    expect(input).toMatchObject({ protocol: "comment-submission/1", body: "Frozen **note** $x$", context: context(), items: [] });
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("A different unsent note"); expect(sessionStorage.length).toBe(0);
  });
  it("hashes the prepared image before creation and checks an uncertain PUT without processing or uploading it twice", async () => {
    const original = new File(["original image"], "original.png", { type: "image/png" });
    const prepared = new File(["prepared pixels"], "prepared.webp", { type: "image/webp" });
    vi.mocked(prepareCommentImage).mockResolvedValue(prepared);
    let input!: AcceptedCommentSubmissionInput; let itemStatus = "pending"; let ready = false; let posts = 0;
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/comment-submissions") { posts += 1; input = JSON.parse(String(init?.body)); return json(await state(input)); }
      if (String(path).endsWith("/acceptance")) return json(await state(input, ready ? "ready" : "pending", itemStatus));
      if (String(path).endsWith("/finalize")) { ready = true; return json(await state(input, "ready", "ready")); }
      throw new Error(`Unexpected ${path}`);
    }));
    const { container } = render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    fireEvent.change(container.querySelector('input[accept]')!, { target: { files: [original] } });
    await screen.findByText("original.png");
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await screen.findByText("The upload response was lost. Retry to check its status.");
    expect(input.items[0]).toMatchObject({ kind: "comment_image", sha256: createHash("sha256").update("prepared pixels").digest("hex"), filename: prepared.name, byteSize: prepared.size });
    expect(xhrs[0].body).toBe(prepared); expect(xhrs[0].headers["x-content-sha256"]).toBe(input.items[0].sha256);
    itemStatus = "uploading"; fireEvent.click(screen.getByRole("button", { name: "Retry incomplete" }));
    await screen.findByText("This file upload is still processing. Retry checks its status without uploading the file again.");
    itemStatus = "ready"; fireEvent.click(screen.getByRole("button", { name: "Retry incomplete" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(xhrs).toHaveLength(1); expect(posts).toBe(1); expect(prepareCommentImage).toHaveBeenCalledOnce(); expect(sessionStorage.length).toBe(0);
  });
  it("restores the same metadata request after remount and settles a published text comment through GET", async () => {
    let input!: AcceptedCommentSubmissionInput; const paths: string[] = []; const refresh = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      paths.push(String(path));
      if (String(path) === "/api/comment-submissions") { input = JSON.parse(String(init?.body)); throw new TypeError("lost"); }
      return json(await state(input, "ready"));
    }));
    const first = render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    typeAndSubmit(); await screen.findByText("The comment response was lost. Retry to check the same request."); first.unmount();
    render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    await screen.findByText("Check the saved comment request. Reselect any file that still needs uploading.");
    fireEvent.click(screen.getByRole("button", { name: "Retry incomplete" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(paths.filter((path) => path === "/api/comment-submissions")).toHaveLength(1); expect(paths.filter((path) => path.endsWith("/finalize"))).toHaveLength(0);
  });
  it("does not start uploads or refresh the new source when an old create finishes after navigation", async () => {
    const pending = deferred<Response>(); let input!: AcceptedCommentSubmissionInput; const refresh = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_path, init) => { input = JSON.parse(String(init?.body)); return pending.promise; }); vi.stubGlobal("fetch", fetchMock);
    const view = render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    typeAndSubmit(); await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    view.rerender(<CommentComposer label="Note" context={context("sample-b")} onSubmitted={refresh} submitLabel="Add note" />);
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("");
    await act(async () => pending.resolve(json(await state(input))));
    expect(fetchMock).toHaveBeenCalledOnce(); expect(refresh).not.toHaveBeenCalled(); expect(xhrs).toHaveLength(0); expect(sessionStorage.length).toBe(1);
  });
  it("rechecks an uncertain cancellation and never resumes the cancelled submission", async () => {
    let input!: AcceptedCommentSubmissionInput; let cancelled = false; let cancelPosts = 0; let createPosts = 0;
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/comment-submissions") { createPosts += 1; input = JSON.parse(String(init?.body)); throw new TypeError("lost create"); }
      if (String(path).endsWith("/acceptance")) return json(await state(input, cancelled ? "cancelled" : "pending"));
      if (String(path).endsWith("/cancel")) { cancelPosts += 1; cancelled = true; throw new TypeError("lost cancel"); }
      throw new Error(`Unexpected ${path}`);
    }));
    render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    typeAndSubmit(); await screen.findByText("The comment response was lost. Retry to check the same request.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelPosts).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Retry incomplete" }));
    await screen.findByText("Cancellation is unresolved. Use Cancel again to check the same request before uploading more files.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(createPosts).toBe(1); expect(cancelPosts).toBe(1); expect(sessionStorage.length).toBe(0);
  });
  it("explains legacy recovery and confirms a lost cancellation without offering an unsupported retry", async () => {
    const submission: CommentSubmission = { id: "legacy-comment-id", contextKind: "sample", scope: null, body: "Historical draft", status: "failed", error: null, images: [], attachments: [], actorEmail: "owner@example.test", createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
    let cancelled = false; let posts = 0; const refresh = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path) => {
      if (String(path).endsWith("/cancel")) { posts += 1; cancelled = true; throw new TypeError("lost legacy cancel"); }
      return json({ request: { submissionId: submission.id, input: null, inputSha256: null, expiresAt: null, items: [], status: cancelled ? "cancelled" : "legacy" } });
    }));
    render(<CommentSubmissionRecovery submissions={[submission]} onSubmitted={refresh} />);
    await screen.findByText("This older or unavailable upload cannot resume. Cancel it and submit a new comment.");
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("The comment response was lost. Retry to check the same request.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); expect(posts).toBe(1);
  });
  it("removes a recovered file from the upload queue when its source unmounts", async () => {
    const blockers = [deferred<void>(), deferred<void>()];
    const running = blockers.map((blocker) => commentUploadQueue.run(() => blocker.promise));
    const file = new File(["data"], "manual.bin", { type: "application/octet-stream" });
    const submission: CommentSubmission = { id: "recovery-comment", contextKind: "sample", scope: null, body: "Recovery", status: "failed", error: null, images: [],
      attachments: [{ id: "recovery-file", kind: "file", title: file.name, description: null, filename: file.name, mimeType: file.type, byteSize: file.size, sha256: null, downloadUrl: null, status: "failed", error: null, relatedCommentImageId: null }],
      actorEmail: "owner@example.test", createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z" };
    vi.spyOn(api, "getCommentSubmissionAcceptance").mockResolvedValue(null);
    const upload = vi.spyOn(api, "uploadCommentSubmissionItem").mockResolvedValue({ ok: true, deduplicated: false });
    const finalize = vi.spyOn(api, "finalizeCommentSubmission").mockResolvedValue({ ok: true, status: "ready" });
    const queue = vi.spyOn(commentUploadQueue, "run");
    try {
      const view = render(<CommentSubmissionRecovery submissions={[submission]} onSubmitted={vi.fn()} />);
      fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
      await waitFor(() => expect(queue).toHaveBeenCalledOnce()); view.unmount();
      await act(async () => { blockers.forEach((blocker) => blocker.resolve()); await Promise.all(running); });
      expect(upload).not.toHaveBeenCalled(); expect(finalize).not.toHaveBeenCalled();
    } finally { blockers.forEach((blocker) => blocker.resolve()); await Promise.all(running); }
  });

  it("lets the user discard a rejected stale request after cancellation fails and gives an explicitly new comment a new ID", async () => {
    const requests: AcceptedCommentSubmissionInput[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path).endsWith("/acceptance")) return new Response("{}", { status: 404 });
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: "Sample revision changed" }), { status: 409 });
    }));
    render(<CommentComposer label="Note" context={context()} onSubmitted={vi.fn()} submitLabel="Add note" />);
    typeAndSubmit(); await screen.findByText("Sample revision changed");
    expect(screen.queryByRole("button", { name: "Discard local request" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Discard local request" });
    expect(screen.getByText("This clears local tracking. An earlier request may still finish.")).toBeTruthy();
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard local request" }));
    expect(sessionStorage.length).toBe(0); expect(screen.queryByText("Upload incomplete")).toBeNull();
    typeAndSubmit("A new explicit comment"); await screen.findByText("Sample revision changed");
    expect(requests).toHaveLength(3); expect(requests[2].id).not.toBe(requests[0].id);
  });
  it("fences a late create acknowledgement after explicit local discard", async () => {
    const original = new File(["pixels"], "diagram.png", { type: "image/png" }); vi.mocked(prepareCommentImage).mockResolvedValue(original);
    const pending = deferred<Response>(); let input!: AcceptedCommentSubmissionInput; let creates = 0; const refresh = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path).endsWith("/acceptance")) return new Response("{}", { status: 404 });
      creates += 1;
      if (creates === 1) { input = JSON.parse(String(init?.body)); return pending.promise; }
      return new Response(JSON.stringify({ error: "Cancellation could not confirm the original request" }), { status: 409 });
    }); vi.stubGlobal("fetch", fetchMock);
    const view = render(<CommentComposer label="Note" context={context()} onSubmitted={refresh} submitLabel="Add note" />);
    fireEvent.change(view.container.querySelector('input[accept]')!, { target: { files: [original] } });
    await screen.findByText("diagram.png"); fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(creates).toBe(1)); fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Discard local request" }); fireEvent.click(screen.getByRole("button", { name: "Discard local request" }));
    expect(sessionStorage.length).toBe(0);
    await act(async () => pending.resolve(json(await state(input))));
    expect(xhrs).toHaveLength(0); expect(refresh).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0);
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/finalize"))).toBe(false);
  });

});
