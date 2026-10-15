// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectItemMutationResponse } from "../shared/project-api";
import { R2_UPLOAD_REQUEST_HEADER } from "../shared/contracts/r2-upload";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

const mapViewport = vi.hoisted(() => ({
  center: { x: 400, y: 300 } as { x: number; y: number } | null,
  reveal: vi.fn(),
}));

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => null,
}));

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: {
      markdownEditor?: ProjectMapMarkdownEditorState | null;
      onMarkdownCreateRequest?: (point: { x: number; y: number }) => void;
      onMarkdownChange?: (value: string) => void;
      onMarkdownSave?: () => void;
      onMarkdownCancel?: () => void;
      onAttachmentRequest?: (point: { x: number; y: number }) => void;
    }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } | null }>) => {
      React.useImperativeHandle(ref, () => ({
        getViewportCenter: () => mapViewport.center,
        ensureGeometryVisible: mapViewport.reveal,
      }));
      return <div>
        <button type="button" onClick={() => props.onMarkdownCreateRequest?.({ x: 100, y: 200 })}>Simulate Markdown double click</button>
        <button type="button" onClick={() => props.onAttachmentRequest?.({ x: 300, y: 240 })}>Simulate attachment request</button>
        {props.markdownEditor && <div>
          <textarea aria-label="Mock Markdown editor" value={props.markdownEditor.value} disabled={props.markdownEditor.status !== "editing"} onChange={(event) => props.onMarkdownChange?.(event.currentTarget.value)} />
          <button type="button" onClick={props.onMarkdownSave}>{props.markdownEditor.status === "uncertain" ? "Retry exact Markdown save" : "Save Markdown"}</button>
          {props.markdownEditor.status !== "saving" && props.markdownEditor.status !== "uncertain" && <button type="button" onClick={props.onMarkdownCancel}>Cancel Markdown</button>}
          {props.markdownEditor.message && <p>{props.markdownEditor.message}</p>}
        </div>}
      </div>;
    }),
  };
});

function desktopMatchMedia() {
  return vi.fn(() => ({
    matches: true,
    media: "(min-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

function mutationResponse(input: Record<string, any>, kind: "markdown" | "attachment", file?: File): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const now = "2026-08-12T21:00:00.000Z";
  return {
    project: { ...snapshot.project, revision: snapshot.project.revision + 1, nextCreatedSequence: snapshot.project.nextCreatedSequence + 1, updatedAt: now },
    item: {
      id: input.itemId,
      projectId: "project-a",
      itemType: "content",
      projectContentId: input.contentId,
      referenceTargetId: null,
      createdSequence: snapshot.project.nextCreatedSequence,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    },
    content: {
      id: input.contentId,
      projectId: "project-a",
      contentType: kind,
      markdownSource: kind === "markdown" ? input.markdownSource : null,
      attachmentCaption: kind === "attachment" ? input.caption : null,
      attachmentSourceUrl: kind === "attachment" ? input.sourceUrl : null,
      formatVersion: 1,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    },
    attachment: kind === "attachment" ? {
      projectContentId: input.contentId,
      originalName: file?.name ?? "attachment.bin",
      mimeType: file?.type || "application/octet-stream",
      byteSize: file?.size ?? 1,
      createdBy: "user@example.com",
      createdAt: now,
      fileUrl: `/api/projects/project-a/contents/${input.contentId}/file`,
    } : null,
    placement: {
      id: input.placementId,
      projectItemId: input.itemId,
      ...input.geometry,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
    },
    replayed: false,
  };
}

describe("mounted Phase 3B3 Project-owned content", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    sessionStorage.clear();
    mapViewport.center = { x: 400, y: 300 };
    mapViewport.reveal.mockClear();
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds Markdown at the current viewport, keeps the draft local, and exact-retries Save", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    // The viewport can move after opening Add; read it when choosing the action.
    mapViewport.center = { x: 600, y: 500 };
    fireEvent.click(screen.getByRole("button", { name: "Note / Markdown" }));
    fireEvent.change(screen.getByLabelText("Mock Markdown editor"), { target: { value: "# New idea" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Temporary create failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    expect(await screen.findByText("Temporary create failure")).toBeTruthy();
    const firstBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-a/items/markdown");
    expect(firstBody).toMatchObject({
      markdownSource: "# New idea", expectedProjectRevision: 2,
      geometry: { x: 420, y: 428, width: 360, height: 220 },
    });
    expect(mapViewport.reveal).toHaveBeenCalledWith(expect.objectContaining({ x: 420, y: 428, width: 360, height: 220 }));

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Create temporarily conflicts" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Markdown save" }));
    await screen.findByText("Create temporarily conflicts");
    expect(screen.queryByRole("button", { name: "Cancel Markdown" })).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(firstBody);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(mutationResponse(firstBody, "markdown")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Markdown save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual(firstBody);
    await waitFor(() => expect(screen.queryByLabelText("Mock Markdown editor")).toBeNull());
  });

  it("uploads a generic Unicode-named file before creating the attachment occurrence", async () => {
    const file = new File(["pdf"], "实验结果.pdf", { type: "application/pdf" });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "asset-uploaded", key: "sha256/x", deduplicated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementationOnce((_path, init) => {
        const input = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(JSON.stringify(mutationResponse(input, "attachment", file)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      });

    renderProjectPage();
    await screen.findByRole("button", { name: "Add" });
    expect(screen.queryByRole("complementary", { name: "Reference search and placement" })).toBeNull();
    const chooseFile = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Attachment" }));
    expect(chooseFile).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Add to Project" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/project-assets");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: file,
      headers: {
        "content-type": "application/pdf",
        "x-project-filename-uri": encodeURIComponent(file.name),
        [R2_UPLOAD_REQUEST_HEADER]: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      },
    });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/projects/project-a/items/attachment");
    const createBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(createBody).toMatchObject({
      locator: { assetId: "asset-uploaded" },
      caption: null,
      sourceUrl: null,
      expectedProjectRevision: 2,
      geometry: { x: 230, width: 340, height: 170 },
    });
    expect(createBody.geometry.y).toBeCloseTo(244, 8);
  });

  it("recovers a lost upload response by checking the same request until ready before creating one attachment", async () => {
    const file = new File(["result bytes"], "recovered.pdf", { type: "application/pdf" });
    const creates: Array<Record<string, any>> = [];
    let requestId: string | null = null;
    let statusChecks = 0;
    let postBody: BodyInit | null | undefined;
    let checkpointsAtPost: Array<string | null> = [];
    const json = (payload: unknown) => new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    });
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return json(projectTestSnapshot());
      if (String(path) === "/api/project-assets") {
        requestId = new Headers(init?.headers).get(R2_UPLOAD_REQUEST_HEADER);
        postBody = init?.body;
        checkpointsAtPost = Array.from({ length: sessionStorage.length }, (_, index) =>
          sessionStorage.getItem(sessionStorage.key(index)!));
        throw new TypeError("Lost upload acknowledgement");
      }
      if (String(path) === `/api/r2-upload-requests/${requestId}`) {
        expect(init).toEqual({ cache: "no-store" });
        statusChecks += 1;
        return json({
          requestId,
          ingress: "project_attachment",
          expiresAt: "2099-01-01T00:00:00.000Z",
          ...(statusChecks === 1 ? { status: "pending" } : {
            status: "ready",
            result: { id: "asset-recovered", key: "uploads/recovered.pdf", deduplicated: false },
          }),
        });
      }
      if (String(path) === "/api/projects/project-a/items/attachment") {
        const input = JSON.parse(String(init?.body));
        creates.push(input);
        return json(mutationResponse(input, "attachment", file));
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Simulate attachment request" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });
    const retry = await screen.findByRole("button", { name: "Retry exact attachment" });
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(postBody).toBe(file);
    expect(checkpointsAtPost.some((value) => value?.includes(requestId!))).toBe(true);
    fireEvent.click(retry);
    await screen.findByText("The upload is still processing. Retry to check its status; the file will not be uploaded again.");
    expect(statusChecks).toBe(1);
    expect(creates).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === "/api/project-assets")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry exact attachment" }));
    await waitFor(() => expect(creates).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry exact attachment" })).toBeNull());
    expect(statusChecks).toBe(2);
    expect(creates[0]).toMatchObject({
      locator: { assetId: "asset-recovered" },
      presentation: { originalName: file.name, mimeType: file.type, byteSize: file.size },
      expectedProjectRevision: 2,
      geometry: { x: 130, width: 340, height: 170 },
    });
    expect(creates[0].geometry.y).toBeCloseTo(240 - 170 / 3, 8);
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === "/api/project-assets")).toHaveLength(1);
  });

  it.each([403, 409])("keeps an uncertain attachment occurrence frozen after non-authoritative %s retry", async (retryStatus) => {
    const file = new File(["pdf"], "frozen.pdf", { type: "application/pdf" });
    const inputs: Record<string, any>[] = [];
    fetchMock.mockImplementation(async (path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) {
        return new Response(JSON.stringify(projectTestSnapshot()), { headers: { "content-type": "application/json" } });
      }
      if (String(path) === "/api/project-assets") {
        return new Response(JSON.stringify({ id: "asset-frozen", key: "uploads/frozen.pdf", deduplicated: false }), { headers: { "content-type": "application/json" } });
      }
      const input = JSON.parse(String(init?.body));
      inputs.push(input);
      if (inputs.length === 1) return new Response(JSON.stringify({ error: "Attachment create response unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      if (inputs.length === 2) return new Response(JSON.stringify({ error: "Attachment retry rejected" }), { status: retryStatus, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ...mutationResponse(input, "attachment", file), replayed: true }), { headers: { "content-type": "application/json" } });
    });
    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Simulate attachment request" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });
    await screen.findByText("Attachment create response unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry exact attachment" }));
    await screen.findByText("Attachment retry rejected");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((screen.getByRole("button", { name: "Attachment" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact attachment" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry exact attachment" })).toBeNull());
    expect(inputs).toHaveLength(3);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === "/api/project-assets")).toHaveLength(1);
  });

  it.each(["Note / Markdown", "Attachment"])("reports an unready viewport for %s without starting a write", async (action) => {
    mapViewport.center = null;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot())));
    const chooseFile = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    renderProjectPage();
    const add = await screen.findByRole("button", { name: "Add" });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.getByText("The Map is still loading. Try adding content again in a moment.")).toBeTruthy();
    expect(screen.queryByLabelText("Mock Markdown editor")).toBeNull();
    expect(chooseFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(add);
  });

  it("keeps Reference discovery available while an existing Markdown draft blocks new content", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot())));
    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Simulate Markdown double click" }));
    expect(screen.queryByRole("complementary", { name: "Reference search and placement" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const menu = screen.getByRole("group", { name: "Add to Project" });
    expect((within(menu).getByRole("button", { name: "Note / Markdown" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(menu).getByRole("button", { name: "Attachment" }) as HTMLButtonElement).disabled).toBe(true);
    const reference = within(menu).getByRole("button", { name: "Reference from research record" });
    expect((reference as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reference);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Reference search and placement" })));
    expect(screen.getByLabelText("Mock Markdown editor")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Add to Project" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("avoids every existing card when Reading repeatedly adds notes and mixed-size attachments", async () => {
    const created: Array<Record<string, any>> = [];
    const files = [new File(["pdf"], "result.pdf", { type: "application/pdf" }),
      new File(["image"], "image.png", { type: "image/png" })];
    const json = (payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    }));
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a") return json(projectTestSnapshot());
      if (String(path) === "/api/project-assets") return json({ id: `asset-${created.length}`, key: `uploads/asset-${created.length}`, deduplicated: false });
      if (String(path).endsWith("/items/markdown") || String(path).endsWith("/items/attachment")) {
        const input = JSON.parse(String(init?.body));
        const kind = String(path).endsWith("/markdown") ? "markdown" : "attachment";
        created.push(input);
        const result = mutationResponse(input, kind, files.find((file) => file.name === input.presentation?.originalName));
        result.project.revision = 2 + created.length;
        result.project.nextCreatedSequence = 3 + created.length;
        result.item.createdSequence = 2 + created.length;
        return json(result);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Reading" }));
    for (let index = 0; index < 2; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.click(screen.getByRole("button", { name: "Note / Markdown" }));
      fireEvent.change(await screen.findByLabelText("New Markdown editor"), { target: { value: `# Added note ${index}` } });
      fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
      await waitFor(() => expect(created).toHaveLength(index + 1));
      await waitFor(() => expect(screen.queryByLabelText("New Markdown editor")).toBeNull());
    }
    for (const [index, file] of files.entries()) {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.click(screen.getByRole("button", { name: "Attachment" }));
      fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });
      await waitFor(() => expect(created).toHaveLength(3 + index));
      await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    }
    const occupied = [...projectTestSnapshot().placements];
    for (const [index, input] of created.entries()) {
      const geometry = input.geometry;
      expect(geometry.width).toBe(index === 2 ? 340 : 360);
      expect(geometry.height).toBe(index < 2 ? 220 : index === 2 ? 170 : 300);
      for (const previous of occupied) {
        expect(geometry.x + geometry.width <= previous.x
          || previous.x + previous.width <= geometry.x
          || geometry.y + geometry.height <= previous.y
          || previous.y + previous.height <= geometry.y).toBe(true);
      }
      occupied.push(geometry);
    }
    expect(mapViewport.reveal).not.toHaveBeenCalled();
  });

  it("keeps explicit attachment coordinates even when they overlap another card", async () => {
    const file = new File(["image"], "exact.png", { type: "image/png" });
    let created: Record<string, any> | null = null;
    fetchMock.mockImplementation(async (path, init) => {
      const payload = String(path) === "/api/projects/project-a" ? projectTestSnapshot()
        : String(path) === "/api/project-assets" ? { id: "exact-asset", key: "uploads/exact.png", deduplicated: false }
        : (() => {
          created = JSON.parse(String(init?.body));
          return mutationResponse(created!, "attachment", file);
        })();
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    });
    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Simulate attachment request" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });
    await waitFor(() => expect(created).not.toBeNull());
    expect((created as unknown as Record<string, any>).geometry).toMatchObject({
      x: 120, y: 168, width: 360, height: 300,
    });
    expect(mapViewport.reveal).not.toHaveBeenCalled();
  });

});
