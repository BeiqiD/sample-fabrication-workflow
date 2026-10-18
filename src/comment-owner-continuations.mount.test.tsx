import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./components/CommentComposer";
import { api } from "./lib/api";
import { readAuthentication } from "./lib/authentication-client";
import * as commentAcceptance from "./lib/comment-submission-client";
import { commentUploadQueue } from "./lib/commentUploadQueue";

// Keep the original component mounted across the identity change: React's
// eventual gate cleanup cannot supply the synchronous account boundary here.
// Hashing, checkpoint persistence and Comment acceptance use their real clients.
const alice = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae";
const bob = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
let principal = alice;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function signInAs(id: string) { principal = id; await readAuthentication(); }
function composer(sampleId: string, onSubmitted: () => Promise<void>) {
  return <CommentComposer label="Note" context={{ kind: "sample", sampleId, expectedUpdatedAt: "2026-10-18T00:00:00.000Z" }}
    onSubmitted={onSubmitted} submitLabel="Add note" />;
}
function posts() { return network.mock.calls.filter(([url, init]) => String(url) === "/api/comment-submissions" && init?.method === "POST"); }

beforeEach(() => {
  sessionStorage.clear(); principal = alice; network.mockReset();
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", network); vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
  vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({
    provider: "r2", available: true, authentication: "service_binding", message: "File storage ready",
  });
  network.mockImplementation(async (path, init) => {
    if (String(path) === "/api/auth/session") return json({ principal: { id: principal, actor: `local-account:${principal}`,
      capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: (principal === alice ? "A" : "B").repeat(43) });
    if (String(path) === "/api/comment-submissions" && init?.method === "POST") throw new Error("Controlled lost acknowledgement");
    throw new Error(`Unexpected fixture request: ${String(path)}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionStorage.clear(); });

describe("mounted Comment asynchronous owner boundaries", () => {
  it.each(["file read", "queued hash"] as const)("does not reassign Alice's pending %s to Bob before the old component unmounts", async (boundary) => {
    await signInAs(alice);
    const onSubmitted = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const view = render(composer("alice-private-sample", onSubmitted));
    const attachment = view.container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await waitFor(() => expect(attachment.disabled).toBe(false));
    const bytes = new TextEncoder().encode("Alice's private attachment").buffer;
    const file = new File([bytes], "alice-private.bin", { type: "application/octet-stream" });
    const read = deferred<ArrayBuffer>();
    const arrayBuffer = vi.fn(() => boundary === "file read" ? read.promise : Promise.resolve(bytes));
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
    fireEvent.change(attachment, { target: { files: [file] } });
    const textarea = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Alice's frozen observation" } });

    // Occupy both actual queue slots before submitting, so this case also
    // catches a queued callback that first captures an owner after the change.
    const blockers = boundary === "queued hash" ? [deferred<void>(), deferred<void>()] : [];
    const running = blockers.map((blocker) => commentUploadQueue.run(() => blocker.promise));
    const queue = vi.spyOn(commentUploadQueue, "run");
    const prepare = vi.spyOn(commentAcceptance, "prepareDurableCommentSubmission");
    const create = vi.spyOn(api, "createCommentSubmission");
    try {
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
      await waitFor(() => expect(queue).toHaveBeenCalledOnce());
      expect(arrayBuffer).toHaveBeenCalledTimes(boundary === "file read" ? 1 : 0);
      expect(posts()).toHaveLength(0); expect(sessionStorage.length).toBe(0);

      await act(async () => { await signInAs(bob); });
      expect(textarea.isConnected).toBe(true);
      await act(async () => {
        read.resolve(bytes); blockers.forEach((blocker) => blocker.resolve());
        await Promise.all(running);
        // Join real continuations, including acceptance preparation and the
        // original create if the regression allowed either one to start.
        await Promise.allSettled(queue.mock.results.map((result) => result.value));
        await Promise.allSettled(prepare.mock.results.map((result) => result.value));
        await Promise.allSettled(create.mock.results.map((result) => result.value));
      });
      expect.soft(posts()).toHaveLength(0);
      expect.soft(sessionStorage.length).toBe(0);
      expect.soft(create).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();

      // A new, explicit Bob operation still uses Bob's session and checkpoint.
      view.unmount();
      render(composer("bob-sample", onSubmitted));
      fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Bob's new observation" } });
      fireEvent.click(screen.getByRole("button", { name: "Add note" }));
      await screen.findByText("The comment response was lost. Retry to check the same request.");
      expect(posts()).toHaveLength(1);
      expect(new Headers(posts()[0][1]?.headers).get("x-sfw-csrf")).toBe("B".repeat(43));
      expect(JSON.parse(String(posts()[0][1]?.body))).toMatchObject({ body: "Bob's new observation", context: { sampleId: "bob-sample" }, items: [] });
      expect(sessionStorage.length).toBe(1);
      const key = sessionStorage.key(0)!;
      expect(decodeURIComponent(key)).toContain(`local-account:${bob}`);
      expect(sessionStorage.getItem(key)).not.toContain("Alice's");
    } finally {
      read.resolve(bytes); blockers.forEach((blocker) => blocker.resolve());
      await Promise.all(running);
      await Promise.allSettled(queue.mock.results.map((result) => result.value));
    }
  });
});
