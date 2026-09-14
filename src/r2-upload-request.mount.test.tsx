// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2_UPLOAD_REQUEST_HEADER } from "../shared/contracts/r2-upload";
import type { TemplateDetail } from "./lib/api";
import { compressLayerStackImage } from "./lib/images";
import { TemplatePage } from "./pages/TemplatePage";

// Keep the selected image and the real upload/state-query integration; image
// encoding itself is separately qualified and would require a browser canvas.
vi.mock("./lib/images", () => ({ compressLayerStackImage: vi.fn() }));

function template(): TemplateDetail {
  return {
    id: "upload-template", recipeFamilyId: "upload-family", name: "Upload template",
    templateType: "process", templateKind: "process", version: 1,
    manifestHash: "upload-manifest", sourceFilename: null,
    initialStateHash: null, initialStateImageKeys: [], initialSubstrateStep: null,
    locked: false, lockedAt: null, createdAt: "2026-09-14T00:00:00.000Z",
    archived: false, metrologyNotes: null, referenceAttachments: [],
    steps: [{
      id: "upload-step", logicalStepKey: "upload-step", definitionHash: "definition",
      expectedStateHash: null, position: 0, sourceRow: null, stepNumber: null,
      sectionName: null, name: "Original step", toolName: "Tool",
      parametersText: null, commentsText: null, imageKeys: [],
    }],
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:fixture-preview");
    static revokeObjectURL = vi.fn();
  });
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mounted ordinary-image request recovery", () => {
  it("starts a distinct request only after the user discards an unresolved upload and selects a file again", async () => {
    const original = new File(["original image"], "original.png", { type: "image/png" });
    const replacement = new File(["replacement image"], "替代图示.png", { type: "image/png" });
    vi.mocked(compressLayerStackImage).mockImplementation(async (file) => file);
    const requestIds: Array<string | null> = [];
    const uploads: Array<{ body: RequestInit["body"]; filename: string | null }> = [];
    const domainInputs: Array<Record<string, unknown>> = [];
    const json = (payload: unknown) => new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/templates/upload-template" && !init?.method) return json({ template: template() });
      if (String(path) === "/api/assets") {
        requestIds.push(new Headers(init?.headers).get(R2_UPLOAD_REQUEST_HEADER));
        uploads.push({ body: init?.body, filename: new Headers(init?.headers).get("X-Filename-Uri") });
        if (requestIds.length === 1) throw new TypeError("First upload acknowledgement was lost");
        return json({ id: "replacement-asset", key: "diagrams/replacement.png", deduplicated: false });
      }
      if (String(path) === "/api/templates/upload-template/steps") {
        domainInputs.push(JSON.parse(String(init?.body)));
        return json({ id: "replacement-step" });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter([{
      path: "/templates/:templateId", element: <TemplatePage />,
    }], { initialEntries: ["/templates/upload-template"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add template step" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Step name" }), { target: { value: "Replacement diagram step" } });
    fireEvent.change(screen.getByRole("button", { name: "Drop a diagram" }).querySelector('input[type="file"]')!, {
      target: { files: [original] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    await screen.findByText("The upload response was lost. Retry to check the same request.");
    expect(screen.getByText("The previous upload may still finish. Discarding lets you choose a new upload.")).toBeTruthy();
    expect(requestIds).toHaveLength(1);
    expect(domainInputs).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Discard upload" }));
    expect(screen.queryByRole("button", { name: "Discard upload" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Selected upload preview" })).toBeNull();
    fireEvent.change(screen.getByRole("button", { name: "Drop a diagram" }).querySelector('input[type="file"]')!, {
      target: { files: [replacement] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add step" })).toBeNull());
    expect(requestIds).toHaveLength(2);
    for (const requestId of requestIds) expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestIds[1]).not.toBe(requestIds[0]);
    expect(uploads[1].body).toBe(replacement);
    expect(uploads[1].filename).toBe(encodeURIComponent(replacement.name));
    expect(domainInputs).toEqual([expect.objectContaining({ assetKey: "diagrams/replacement.png" })]);
    expect(compressLayerStackImage).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith("/api/r2-upload-requests/"))).toBe(false);
    router.dispose();
  });

  it.each(["new", "edit"] as const)("prepares the %s-step diagram once and revalidates the upload on every retry", async (mode) => {
    const selected = new File(["original large image"], "diagram-original.png", { type: "image/png" });
    const prepared = new File(["prepared image bytes"], "图示-compressed.png", { type: "image/png" });
    vi.mocked(compressLayerStackImage).mockResolvedValue(prepared);
    const operations: string[] = [];
    const domainInputs: Array<Record<string, unknown>> = [];
    const uploads: Array<{ method: RequestInit["method"]; body: RequestInit["body"]; filename: string | null; checkpoint: string | null }> = [];
    let requestId: string | null = null;
    let templateReads = 0;
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
      status, headers: { "content-type": "application/json" },
    });
    const domainPath = mode === "new" ? "/api/templates/upload-template/steps"
      : "/api/templates/upload-template/steps/upload-step";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/templates/upload-template" && !init?.method) {
        templateReads += 1;
        return json({ template: template() });
      }
      if (String(path) === "/api/assets") {
        operations.push("upload");
        requestId = new Headers(init?.headers).get(R2_UPLOAD_REQUEST_HEADER);
        const checkpointKey = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
          .find((key) => key?.startsWith("r2-upload-request-v1:ordinary_image:"));
        uploads.push({
          method: init?.method, body: init?.body,
          filename: new Headers(init?.headers).get("X-Filename-Uri"),
          checkpoint: checkpointKey ? sessionStorage.getItem(checkpointKey) : null,
        });
        throw new TypeError("Upload acknowledgement was lost");
      }
      if (String(path) === `/api/r2-upload-requests/${requestId}`) {
        operations.push("status");
        expect(init).toEqual({ cache: "no-store" });
        return json({
          requestId, ingress: "ordinary_image", expiresAt: "2099-01-01T00:00:00.000Z",
          status: "ready", result: { id: "diagram-asset", key: "diagrams/prepared.png", deduplicated: false },
        });
      }
      if (String(path) === domainPath) {
        operations.push("domain");
        domainInputs.push(JSON.parse(String(init?.body)));
        if (domainInputs.length === 1) return json({ error: "Step save temporarily unavailable" }, 503);
        return json(mode === "new" ? { id: "created-step" } : { ok: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const router = createMemoryRouter([{
      path: "/templates/:templateId", element: <TemplatePage />,
    }], { initialEntries: ["/templates/upload-template"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: "Upload template" });
    fireEvent.click(screen.getByRole("button", { name: mode === "new" ? "+ Add template step" : "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Step name" }), { target: { value: "Prepared step" } });
    const dropzone = screen.getByRole("button", { name: mode === "new" ? "Drop a diagram" : "Drop another diagram" });
    fireEvent.change(dropzone.querySelector('input[type="file"]')!, { target: { files: [selected] } });
    const saveLabel = mode === "new" ? "Add step" : "Save step";

    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await screen.findByText("The upload response was lost. Retry to check the same request.");
    // Assertions belong outside the intentionally rejected fetch: the client
    // correctly catches all fetch errors, including an assertion thrown there.
    expect(uploads).toHaveLength(1);
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uploads[0].method).toBe("POST");
    expect(uploads[0].body).toBe(prepared);
    expect(uploads[0].filename).toBe(encodeURIComponent(prepared.name));
    expect(JSON.parse(uploads[0].checkpoint!)).toMatchObject({
      requestId, ingress: "ordinary_image", filename: prepared.name,
      mimeType: prepared.type, byteSize: prepared.size,
    });
    expect(domainInputs).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await screen.findByText("Step save temporarily unavailable");
    expect(domainInputs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: saveLabel }));
    await waitFor(() => expect(templateReads).toBe(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: saveLabel })).toBeNull());

    expect(operations).toEqual(["upload", "status", "domain", "status", "domain"]);
    expect(compressLayerStackImage).toHaveBeenCalledOnce();
    expect(compressLayerStackImage).toHaveBeenCalledWith(selected);
    expect(domainInputs).toHaveLength(2);
    expect(domainInputs[0]).toMatchObject({ name: "Prepared step", assetKey: "diagrams/prepared.png" });
    expect(domainInputs[1]).toEqual(domainInputs[0]);
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === "/api/assets")).toHaveLength(1);
    router.dispose();
  });
});
