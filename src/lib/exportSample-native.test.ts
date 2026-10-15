import { afterEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../../shared/types";
import { exportSample } from "./exportSample";

const capture = vi.hoisted(() => ({ files: new Map<string, unknown>() }));
vi.mock("jszip", () => ({ default: class {
  file(path: string, value: unknown) { capture.files.set(path, value); return this; }
  async generateAsync() { return new Blob(["fixture archive"]); }
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); capture.files.clear(); });

describe("Sample readable export with native File media", () => {
  it("packages repeated native media once and links its actual bytes from Markdown while retaining JSON provenance", async () => {
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
});
