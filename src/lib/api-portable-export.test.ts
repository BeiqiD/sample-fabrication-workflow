import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("negotiates the paired current V26 export once with the current writer", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ schemaVersion: 26 })); vi.stubGlobal("fetch", fetchMock);
  await expect(api.getFullExport()).resolves.toEqual({ schemaVersion: 26 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/exports/all?archiveSchema=26&archiveWriter=1");
});
it("preserves a current export refusal without falling back to an older archive schema", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "Refresh required" }, { status: 409 })); vi.stubGlobal("fetch", fetchMock);
  await expect(api.getFullExport()).rejects.toThrow("Refresh required"); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("cancels the manifest body through the caller's export signal", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  vi.stubGlobal("fetch", fetchMock);
  const exporting = api.getFullExport(controller.signal);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  controller.abort();
  await expect(exporting).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
});
it("refuses an oversized manifest before buffering its declared body", async () => {
  let cancelled = false;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), {
    headers: { "content-length": "8000001" },
  })));
  await expect(api.getFullExport()).rejects.toThrow(/metadata|budget|limit/i);
  expect(cancelled).toBe(true);
});
