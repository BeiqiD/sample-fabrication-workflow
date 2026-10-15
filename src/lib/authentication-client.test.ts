import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Client protocol tests only: delivered responses are controlled fixtures.
// They do not qualify cookies, transport admission, identity SQL or live login.
const origin = "http://127.0.0.1:48761";
const id = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae";
const otherId = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a";
const tokenA = "A".repeat(43), tokenB = "B".repeat(43);
function delivered(csrf = tokenA, principalId = id) {
  return { principal: { id: principalId, actor: `local-account:${principalId}`,
    capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
});
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("local authentication browser client protocol", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.resetModules(); fetchMock.mockReset();
    vi.stubGlobal("window", { location: { origin, href: `${origin}/projects/project.one?tab=map#item` } });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("preserves all Cloudflare argument identities and arities without a session probe", async () => {
    vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "");
    const client = await import("./authentication-client");
    const response = new Response("original"); fetchMock.mockResolvedValue(response);
    const input = new Request("https://example.test/api/records", { method: "POST", body: "body" });
    const init = { headers: { "x-original": "kept" }, credentials: "omit" as const };
    expect(await client.applicationFetch(input)).toBe(response);
    expect(await client.applicationFetch(input, undefined)).toBe(response);
    expect(await client.applicationFetch(input, init)).toBe(response);
    expect(fetchMock.mock.calls).toEqual([[input], [input, undefined], [input, init]]);
    expect(client.usesLocalAuthentication()).toBe(false);
    expect(client.authenticationSnapshot().phase).toBe("loading");
  });

  it("does not put CSRF on local reads or alter the original response/body/signal", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication();
    fetchMock.mockClear();
    const signal = new AbortController().signal, body = "original-body";
    const response = new Response("unchanged"); fetchMock.mockResolvedValueOnce(response);
    const init = { method: "GET", headers: { "x-sfw-csrf": "caller-value", "x-kept": "yes" }, signal, cache: "no-store" as const };
    expect(await client.applicationFetch("/api/samples", init)).toBe(response);
    const [input, sent] = fetchMock.mock.calls[0]!;
    expect(input).toBe("/api/samples"); expect(sent?.signal).toBe(signal);
    expect(sent?.cache).toBe("no-store"); expect(sent?.credentials).toBe("same-origin"); expect(sent?.redirect).toBe("error");
    const headers = new Headers(sent?.headers);
    expect(headers.has("x-sfw-csrf")).toBe(false); expect(headers.get("x-kept")).toBe("yes");
    expect(init.headers["x-sfw-csrf"]).toBe("caller-value");
    expect(await response.text()).toBe("unchanged");
    const request = new Request(`${origin}/api/samples`, { method: "POST", body, signal,
      headers: { "content-type": "text/plain", "x-sfw-csrf": "caller-value" } });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.applicationFetch(request);
    expect(fetchMock.mock.calls[1]![0]).toBe(request); expect(request.bodyUsed).toBe(false);
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get("x-sfw-csrf")).toBe(tokenA);
    expect(request.headers.get("x-sfw-csrf")).toBe("caller-value"); expect(await request.text()).toBe(body);
  });

  it("rejects foreign origins, credentials in URLs and non-API paths before any request", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication(); fetchMock.mockClear();
    for (const path of ["https://example.test/api/write", "//example.test/api/write", origin.replace("http://", "http://user:pass@") + "/api/write",
      "/api", "/assets/part.js", "data:text/plain,secret", "/api/../assets/part.js"]) {
      await expect(client.applicationFetch(path, { method: "POST", body: "change" })).rejects.toThrow("Application request is unavailable.");
    }
    expect(fetchMock).not.toHaveBeenCalled(); expect(client.authenticationSnapshot().phase).toBe("authenticated");
  });

  it("does not send anonymous mutations and sends the exact valid password once", async () => {
    const client = await import("./authentication-client");
    await expect(client.applicationFetch("/api/samples", { method: "POST", body: "change" })).rejects.toThrow("Sign in before changing records.");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(delivered()));
    const password = "normal-r0-password-非生产";
    await client.signIn("operator", password);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/login");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ username: "operator", password });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(client.authenticationSnapshot()).toEqual({ phase: "authenticated", principal: { id, actor: `local-account:${id}` }, message: null });
    expect(JSON.stringify(client.authenticationSnapshot())).not.toContain(tokenA);
  });

  it("rejects actual controls and UTF-8 password overflow without sending credentials", async () => {
    const client = await import("./authentication-client");
    for (const password of ["", "has\rreturn", "has\nnewline", "has\0nul", "é".repeat(513), "x".repeat(1025)]) {
      await client.signIn("operator", password); expect(client.authenticationSnapshot().phase).toBe("anonymous");
    }
    await client.signIn("Invalid Account", "valid-password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("invalid credentials fence a previously pending session delivery", async () => {
    const client = await import("./authentication-client"), first = pending<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    const read = client.readAuthentication();
    await client.signIn("invalid account", "valid-password");
    first.resolve(json(delivered())); await read;
    expect(client.authenticationSnapshot().phase).toBe("anonymous"); expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.applicationFetch("/api/samples", { method: "PATCH", body: "change" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an old session failure after a newer login delivery", async () => {
    const client = await import("./authentication-client"), first = pending<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(json(delivered(tokenB, otherId)));
    const read = client.readAuthentication(); await client.signIn("operator", "normal-r0-password");
    first.resolve(new Response(null, { status: 503 })); await read;
    expect(client.authenticationSnapshot().principal?.id).toBe(otherId); expect(client.authenticationSnapshot().phase).toBe("authenticated");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.applicationFetch("/api/samples", { method: "PATCH", body: "change" });
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get("x-sfw-csrf")).toBe(tokenB);
  });

  it("bounds streamed session delivery and cancels an overflowing body without granting a session", async () => {
    const client = await import("./authentication-client"); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2048)); controller.enqueue(new Uint8Array(2049)); },
      cancel() { cancelled = true; },
    });
    fetchMock.mockResolvedValueOnce(new Response(body)); await client.readAuthentication();
    expect(cancelled).toBe(true); expect(body.locked).toBe(false); expect(client.authenticationSnapshot().phase).toBe("error");
    await expect(client.applicationFetch("/api/samples", { method: "POST" })).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for malformed delivery, mismatched actors, unsupported grants and raw bearers", async () => {
    const client = await import("./authentication-client");
    const malformed = [null, [], { ...delivered(), token: "raw-bearer" }, { ...delivered(), csrf: "short" },
      { ...delivered(), principal: { ...delivered().principal, actor: "local-account:other" } },
      { ...delivered(), principal: { ...delivered().principal, id: "local_invalid" } },
      { ...delivered(), principal: { ...delivered().principal, capabilities: { systemAdministrator: 1, fileEvidenceOperator: false } } },
      { ...delivered(), principal: { ...delivered().principal, capabilities: { systemAdministrator: false, fileEvidenceOperator: true } } }];
    for (const value of malformed) {
      fetchMock.mockResolvedValueOnce(json(value)); await client.readAuthentication();
      expect(client.authenticationSnapshot().phase).toBe("error"); expect(client.authenticationSnapshot().principal).toBeNull();
    }
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff]))); await client.readAuthentication();
    expect(client.authenticationSnapshot().phase).toBe("error");
    await expect(client.applicationFetch("/api/samples", { method: "PUT" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(malformed.length + 1);
  });

  it("treats session 401 as anonymous and allows only an explicit new status check", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })); await client.readAuthentication();
    expect(client.authenticationSnapshot().phase).toBe("anonymous"); expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication();
    expect(client.authenticationSnapshot().phase).toBe("authenticated"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an expired mutation response unchanged, clears CSRF and never replays it", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication(); fetchMock.mockClear();
    const response = json({ error: "Authentication is required." }, 401); fetchMock.mockResolvedValueOnce(response);
    const init = { method: "POST", body: "one-change" };
    expect(await client.applicationFetch("/api/samples", init)).toBe(response);
    expect(await response.json()).toEqual({ error: "Authentication is required." });
    expect(client.authenticationSnapshot().phase).toBe("anonymous"); expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.applicationFetch("/api/samples", init)).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let an old business 401 clear a newer authenticated generation", async () => {
    const client = await import("./authentication-client"), old = pending<Response>();
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication();
    fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(json(delivered(tokenB, otherId)));
    const request = client.applicationFetch("/api/samples"); await client.signIn("operator", "normal-r0-password");
    const original = new Response(null, { status: 401 }); old.resolve(original);
    expect(await request).toBe(original); expect(client.authenticationSnapshot().principal?.id).toBe(otherId);
  });

  it("keeps permission denials and uncertain mutation failures with the caller without retries", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication(); fetchMock.mockClear();
    const response = json({ error: "permission" }, 403); fetchMock.mockResolvedValueOnce(response);
    expect(await client.applicationFetch("/api/storage/configuration/candidate", { method: "PUT", body: "change" })).toBe(response);
    const failure = new Error("response delivery lost"), signal = new AbortController().signal;
    fetchMock.mockRejectedValueOnce(failure);
    await expect(client.applicationFetch("/api/samples", { method: "POST", body: "change", signal })).rejects.toBe(failure);
    expect(fetchMock.mock.calls[1]![1]?.signal).toBe(signal);
    expect(client.authenticationSnapshot().phase).toBe("authenticated"); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends one logout with derived CSRF and admits no second logout or write after success", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication(); fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })); await client.signOut(); await client.signOut();
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/logout");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-sfw-csrf")).toBe(tokenA);
    expect(client.authenticationSnapshot().phase).toBe("anonymous");
    await expect(client.applicationFetch("/api/samples", { method: "DELETE" })).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown login/logout outcomes behind explicit status checking instead of auth replay", async () => {
    const client = await import("./authentication-client");
    fetchMock.mockRejectedValueOnce(new Error("login ACK lost")); await client.signIn("operator", "normal-r0-password");
    expect(client.authenticationSnapshot().phase).toBe("error"); expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json(delivered())); await client.readAuthentication();
    fetchMock.mockRejectedValueOnce(new Error("logout ACK lost")); await client.signOut();
    expect(client.authenticationSnapshot().phase).toBe("error"); expect(fetchMock).toHaveBeenCalledTimes(3);
    await client.signOut(); await expect(client.applicationFetch("/api/samples", { method: "POST" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })); await client.readAuthentication();
    expect(client.authenticationSnapshot().phase).toBe("anonymous");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/auth/login", "/api/auth/session", "/api/auth/logout", "/api/auth/session"]);
  });
});
