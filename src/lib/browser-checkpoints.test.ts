import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalCommentAcceptanceInput, type AcceptedCommentSubmissionInput } from "../../shared/contracts/comment-acceptance";

const alice = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae", bob = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const delivered = (id: string) => json({ principal: { id, actor: `local-account:${id}`, capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: (id === alice ? "A" : "B").repeat(43) });
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); }, key: (index: number) => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
const network = vi.fn<typeof fetch>();
let raw: ReturnType<typeof storage>;
beforeEach(() => {
  vi.resetModules(); vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1"); raw = storage(); network.mockReset();
  vi.stubGlobal("sessionStorage", raw); vi.stubGlobal("fetch", network);
  vi.stubGlobal("window", { location: { origin: "http://localhost", href: "http://localhost/samples/sample-a" } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("principal-bound browser checkpoints and outstanding work", () => {
  it("isolates keys and key enumeration, keeps unowned bytes unchanged, and restores the original account's exact state", async () => {
    const auth = await import("./authentication-client"), { checkpointStorage } = await import("./browser-checkpoints");
    const legacy = '{"requestId":"old-unowned","private":"retained"}'; raw.setItem("research-package-operation", legacy);
    network.mockResolvedValueOnce(delivered(alice)); await auth.readAuthentication();
    const original = checkpointStorage(); expect(original.getItem("research-package-operation")).toBeNull();
    original.setItem("research-package-operation", "Alice's exact intent");
    network.mockResolvedValueOnce(delivered(bob)); await auth.readAuthentication();
    const next = checkpointStorage(); expect(next.length).toBe(0); expect(next.getItem("research-package-operation")).toBeNull();
    next.setItem("research-package-operation", "Bob's separate intent");
    expect(next.length).toBe(1); expect(next.key(0)).toBe("research-package-operation");
    expect(() => original.setItem("research-package-operation", "stale update")).toThrow("sign-in changed");
    network.mockResolvedValueOnce(delivered(alice)); await auth.readAuthentication();
    const restored = checkpointStorage(); expect(restored.getItem("research-package-operation")).toBe("Alice's exact intent");
    expect(restored.length).toBe(1); expect(raw.getItem("research-package-operation")).toBe(legacy);
  });

  it("fences a delivered response after an authentication generation changes even for the same account", async () => {
    const auth = await import("./authentication-client");
    network.mockResolvedValueOnce(delivered(alice)); await auth.readAuthentication();
    const owner = auth.captureApplicationOwner(), held = deferred<Response>();
    network.mockReturnValueOnce(held.promise); const pending = owner.fetch("/api/samples", { method: "POST", body: "original" });
    const outcome = expect(pending).rejects.toThrow("sign-in changed");
    network.mockResolvedValueOnce(delivered(alice)); await auth.readAuthentication();
    held.resolve(json({ saved: true })); await outcome;
    expect(network.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not send an old R2 upload when file reading finishes after the account changes", async () => {
    const auth = await import("./authentication-client"), client = await import("./r2-upload-client");
    network.mockResolvedValueOnce(delivered(alice)); await auth.readAuthentication();
    const held = deferred<ArrayBuffer>(), file = new Blob(["data"], { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: () => held.promise });
    const pending = client.uploadR2Asset(file, "sample.png", "ordinary_image", { context: "template:a" });
    const outcome = expect(pending).rejects.toThrow();
    network.mockResolvedValueOnce(delivered(bob)); await auth.readAuthentication();
    held.resolve(new TextEncoder().encode("data").buffer); await outcome;
    expect(network.mock.calls.map(([path]) => path)).toEqual(["/api/auth/session", "/api/auth/session"]); expect(raw.length).toBe(0);
  });

  it("never joins another actor's in-flight comment hash and sends only the new actor's own input", async () => {
    const source: AcceptedCommentSubmissionInput = { protocol: "comment-submission/1", id: crypto.randomUUID(), body: "Alice's text",
      context: { kind: "sample", sampleId: "sample-a", expectedUpdatedAt: "2026-10-18T00:00:00.000Z" }, items: [] };
    const next = { ...source, body: "Bob's text" }, canonical = await canonicalCommentAcceptanceInput(next);
    const auth = await import("./authentication-client"), client = await import("./comment-submission-client");
    network.mockResolvedValueOnce(delivered(alice)); await auth.readAuthentication();
    const held = deferred<void>(), digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => { await held.promise; return digest(algorithm, bytes); });
    const old = client.createDurableCommentSubmission(source), oldOutcome = expect(old).rejects.toThrow("sign-in changed");
    network.mockResolvedValueOnce(delivered(bob)); await auth.readAuthentication();
    expect(client.savedCommentSubmissions()).toEqual([]);
    network.mockResolvedValueOnce(json({ request: { submissionId: next.id, inputSha256: canonical.sha256, input: canonical.input,
      expiresAt: "2099-01-01T00:00:00.000Z", status: "pending", items: [] } }));
    await expect(client.createDurableCommentSubmission(next)).resolves.toEqual({ id: next.id, deduplicated: false });
    held.resolve(); await oldOutcome;
    const sent = network.mock.calls.filter(([, init]) => init?.method === "POST"); expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0][1]?.body)).body).toBe("Bob's text");
    expect(new Headers(sent[0][1]?.headers).get("x-sfw-csrf")).toBe("B".repeat(43));
  });
});
