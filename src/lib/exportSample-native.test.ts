import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../../shared/types";

const capture = vi.hoisted(() => ({ files: new Map<string, unknown>(), generating: false, archive: null as Promise<Blob> | null }));
vi.mock("jszip", () => ({ default: class {
  file(path: string, value: unknown) { capture.files.set(path, value); return this; }
  async generateAsync() { capture.generating = true; return capture.archive ?? new Blob(["fixture archive"]); }
} }));
beforeEach(() => { vi.resetModules(); capture.generating = false; capture.archive = null; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); capture.files.clear(); });

describe("Sample readable export with native File media", () => {
  it("packages repeated native media once and links its actual bytes from Markdown while retaining JSON provenance", async () => {
    const { exportSample } = await import("./exportSample");
    const url = "/api/file-assets/native-image", bytes = "native image bytes";
    const fetch = vi.fn(async (url: string) => {
      if (url !== "/api/file-assets/native-image") throw new Error("Unexpected storage locator");
      return new Response(bytes);
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("document", { createElement: () => ({ href: "", download: "", click: vi.fn() }) });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sample-export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const sample = { code: "NATIVE", title: "Native File sample", status: "stored", location: null,
      createdAt: "2026-10-05T12:00:00.000Z", description: null, runs: [], stateVerifications: [],
      events: [{ id: "event", kind: "image", body: "Timeline image", assetKey: null, assetUrl: url,
        metadata: { assetId: "native-image" }, createdAt: "2026-10-05T12:00:00.000Z" }],
      comments: [{ id: "comment", status: "ready", body: "Native Comment", createdAt: "2026-10-05T12:00:00.000Z",
        images: [{ id: "item", assetKey: null, assetId: "native-image", fileId: "native-file", assetUrl: url, filename: "surface.png" }], attachments: [] }],
    } as unknown as SampleDetail;
    await exportSample(sample);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url);
    expect(await (capture.files.get("assets/native/native-image") as Blob).text()).toBe(bytes);
    expect(capture.files.get("sample.md")).toContain("![surface.png](assets/native/native-image)");
    expect(capture.files.get("sample.md")).toContain("![Timeline image](assets/native/native-image)");
    expect(JSON.parse(String(capture.files.get("sample.json"))).comments[0].images[0])
      .toMatchObject({ assetKey: null, assetId: "native-image", fileId: "native-file", assetUrl: url });
  });

  it.each(["asset", "archive"])("stops an export when the account changes while %s bytes are pending", async stage => {
    vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1");
    vi.stubGlobal("window", { location: { origin: "http://localhost", href: "http://localhost/samples/sample-a" } });
    const auth = await import("./authentication-client"), { exportSample } = await import("./exportSample");
    let account = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae", release!: (value: Blob) => void;
    const pendingBytes = new Promise<Blob>(resolve => { release = resolve; });
    const first = new Response("first asset"); vi.spyOn(first, "blob").mockReturnValue(pendingBytes);
    if (stage === "archive") capture.archive = pendingBytes;
    const network = vi.fn<typeof fetch>(async path => {
      if (path === "/api/auth/session") return new Response(JSON.stringify({ principal: { id: account, actor: `local-account:${account}`,
        capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: "A".repeat(43) }));
      if (path === "/api/file-assets/first") return first;
      if (path === "/api/file-assets/second") return new Response("second asset");
      throw new Error("Unexpected export request");
    });
    vi.stubGlobal("fetch", network); const download = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ href: "", download: "", click: download }) });
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sample-export");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await auth.readAuthentication();
    const sample = { code: "PRIVATE", title: "Original account's sample", status: "stored", createdAt: "2026-10-18T00:00:00.000Z",
      runs: [], comments: [], stateVerifications: [], events: stage === "asset" ? ["first", "second"].map(id => ({ id, kind: "image",
        body: id, assetKey: null, assetUrl: `/api/file-assets/${id}`, metadata: {}, createdAt: "2026-10-18T00:00:00.000Z" })) : [],
    } as unknown as SampleDetail;
    const exporting = exportSample(sample), result = expect(exporting).rejects.toThrow("sign-in changed");
    await vi.waitFor(() => expect(stage === "archive" ? capture.generating : network.mock.calls.some(([path]) => path === "/api/file-assets/first")).toBe(true));
    account = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a"; await auth.readAuthentication();
    release(new Blob(["finished bytes"])); await result;
    expect(network.mock.calls.some(([path]) => path === "/api/file-assets/second")).toBe(false);
    expect(objectUrl).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  });
});
