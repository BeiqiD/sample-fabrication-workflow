// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetrologyTemplateReference, TemplateDetail } from "./lib/api";
import { MetrologyTemplatePage } from "./pages/MetrologyTemplatePage";

const selected = () => new File(["reference manual bytes"], "设备手册 α.pdf", { type: "application/pdf" });
const referenceFor = (file: File): MetrologyTemplateReference => ({ id: "reference-id", filename: file.name, mimeType: file.type, byteSize: file.size, assetKey: "references/manual.pdf", createdAt: "2026-09-14T00:00:00.000Z" });
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
function template(id = "A", references: MetrologyTemplateReference[] = []): TemplateDetail {
  return {
    id, recipeFamilyId: `${id}-family`, name: `Template ${id}`, templateType: "module", templateKind: "metrology", version: 1,
    manifestHash: `${id}-manifest`, sourceFilename: null, initialStateHash: null, initialStateImageKeys: [], initialSubstrateStep: null,
    locked: false, lockedAt: null, createdAt: "2026-09-14T00:00:00.000Z", archived: false, metrologyNotes: `Server notes ${id}`, referenceAttachments: references,
    steps: [{ id: `${id}-step`, logicalStepKey: `${id}-step`, definitionHash: `${id}-definition`, expectedStateHash: null, position: 0,
      sourceRow: null, stepNumber: null, sectionName: null, name: `Step ${id}`, toolName: `Tool ${id}`, parametersText: null, commentsText: null, imageKeys: [] }],
  };
}
function state(requestId: string, file: File, status = "ready", templateId = "A") {
  return { request: { requestId, templateId, status, expiresAt: "2099-01-01T00:00:00.000Z",
    ...(status === "ready" ? { result: { assetId: "asset-id", deduplicated: false, reference: referenceFor(file) } } : {}) } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const routers: ReturnType<typeof createMemoryRouter>[] = [];
function open() {
  const router = createMemoryRouter([{ path: "/templates/metrology/:templateId", element: <MetrologyTemplatePage /> }], { initialEntries: ["/templates/metrology/A"] });
  routers.push(router); return { router, ...render(<RouterProvider router={router} />) };
}
function choose(container: HTMLElement, file: File) {
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}
beforeEach(() => {
  sessionStorage.clear(); vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); routers.splice(0).forEach((router) => router.dispose()); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("mounted metrology reference upload recovery", () => {
  it("retains the selected file and publication receipt across a lost POST and failed page refresh", async () => {
    const file = selected(); const events: string[] = []; let requestId = ""; let reads = 0; let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/templates/A") {
        reads += 1;
        if (reads === 2) return json({ error: "Template refresh unavailable" }, 503);
        return json({ template: template("A", reads > 2 ? [referenceFor(file)] : []) });
      }
      if (String(path) === "/api/metrology-templates/A/references") {
        events.push("POST"); captured = init; requestId = new Headers(init?.headers).get("X-Upload-Request-Id")!;
        throw new TypeError("Lost upload acknowledgement");
      }
      if (String(path) === `/api/metrology-templates/A/reference-upload-requests/${requestId}`) {
        events.push("GET"); return json(state(requestId, file));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const { container } = open(); await screen.findByRole("heading", { name: "Template A" });
    fireEvent.change(screen.getByRole("textbox", { name: "Reference notes" }), { target: { value: "Unsaved local notes" } });
    choose(container, file); fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await screen.findByText("The reference upload response was lost. Retry to check the same request.");
    expect(captured?.body).toBe(file);
    expect(new Headers(captured?.headers).get("X-Filename-Uri")).toBe(encodeURIComponent(file.name));
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    fireEvent.click(screen.getByRole("button", { name: "Check reference upload" }));
    await screen.findByText("Template refresh unavailable");
    expect(screen.getByRole("button", { name: `Replace ${file.name}` })).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).observedReady).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check reference upload" }));
    await screen.findByText("Reference file attached.");
    expect(events).toEqual(["POST", "GET", "GET"]);
    expect(screen.getByRole("link", { name: new RegExp(file.name) }).getAttribute("href")).toBe("/api/assets/references/manual.pdf");
    expect(screen.queryByRole("button", { name: "Check reference upload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard reference upload" })).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect((screen.getByRole("textbox", { name: "Reference notes" }) as HTMLTextAreaElement).value).toBe("Unsaved local notes");
  });

  it("recovers pending tracking after remount and re-selection without another POST", async () => {
    const file = selected(); let requestId = ""; let complete = false; const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/templates/A") return json({ template: template("A", complete ? [referenceFor(file)] : []) });
      if (String(path) === "/api/metrology-templates/A/references") {
        methods.push("POST"); requestId = new Headers(init?.headers).get("X-Upload-Request-Id")!; return json(state(requestId, file, "pending"), 202);
      }
      if (String(path) === `/api/metrology-templates/A/reference-upload-requests/${requestId}`) { methods.push("GET"); complete = true; return json(state(requestId, file)); }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const first = open(); await screen.findByRole("heading", { name: "Template A" });
    choose(first.container, file); fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await screen.findByText("The reference upload is still processing. Check its status again; the file will not be uploaded again.");
    first.unmount(); first.router.dispose();
    const second = open(); await screen.findByRole("heading", { name: "Template A" });
    expect(screen.getByText(`Reselect ${file.name} to check the previous upload, or discard it to start another.`)).toBeTruthy();
    choose(second.container, selected()); fireEvent.click(screen.getByRole("button", { name: "Check reference upload" }));
    await screen.findByText("Reference file attached."); expect(methods).toEqual(["POST", "GET"]); expect(sessionStorage.length).toBe(0);
  });

  it("allows a different request only after explicit discard and retains the warning while replacing an unresolved file", async () => {
    const file = selected(); const replacement = new File(["other bytes"], "另一个文件.pdf", { type: "application/pdf" });
    const requests: string[] = []; let complete = false;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path) === "/api/templates/A") return json({ template: template("A", complete ? [referenceFor(replacement)] : []) });
      if (String(path) === "/api/metrology-templates/A/references") {
        const id = new Headers(init?.headers).get("X-Upload-Request-Id")!; requests.push(id);
        if (requests.length === 1) throw new TypeError("Lost acknowledgement");
        complete = true; return json(state(id, replacement), 201);
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const { container } = open(); await screen.findByRole("heading", { name: "Template A" });
    choose(container, file); fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await screen.findByText("The reference upload response was lost. Retry to check the same request.");
    choose(container, replacement); fireEvent.click(screen.getByRole("button", { name: "Check reference upload" }));
    await screen.findByText("A previous reference upload is unresolved. Reselect its original file to check it, or discard the upload before choosing another file.");
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard reference upload" }));
    expect(screen.queryByRole("button", { name: "Check reference upload" })).toBeNull();
    choose(container, replacement); fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await screen.findByText("Reference file attached."); expect(requests).toHaveLength(2); expect(requests[1]).not.toBe(requests[0]);
  });

  it("disables file replacement during upload and ignores completion after a different template opens", async () => {
    const file = selected(); const response = deferred<Response>(); const reads: string[] = []; let requestId = "";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/templates/")) { const id = String(path).split("/").at(-1)!; reads.push(id); return json({ template: template(id) }); }
      if (String(path) === "/api/metrology-templates/A/references") { requestId = new Headers(init?.headers).get("X-Upload-Request-Id")!; return response.promise; }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const { router, container } = open(); await screen.findByRole("heading", { name: "Template A" });
    choose(container, file); fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await waitFor(() => expect(requestId).not.toBe(""));
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: `Replace ${file.name}` }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => { await router.navigate("/templates/metrology/B"); });
    await screen.findByRole("heading", { name: "Template B" });
    await act(async () => { response.resolve(json(state(requestId, file), 201)); });
    expect(reads).toEqual(["A", "B"]); expect(screen.queryByText("Reference file attached.")).toBeNull();
    expect(screen.queryByText(file.name)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).observedReady).toBe(true);
  });
});
