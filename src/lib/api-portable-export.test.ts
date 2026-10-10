import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
afterEach(() => vi.unstubAllGlobals());
it("negotiates the paired current V25 export once with the current writer", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ schemaVersion: 25 })); vi.stubGlobal("fetch", fetchMock);
  await expect(api.getFullExport()).resolves.toEqual({ schemaVersion: 25 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/exports/all?archiveSchema=25&archiveWriter=1");
});
it("preserves a current export refusal without falling back to an older archive schema", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "Refresh required" }, { status: 409 })); vi.stubGlobal("fetch", fetchMock);
  await expect(api.getFullExport()).rejects.toThrow("Refresh required"); expect(fetchMock).toHaveBeenCalledTimes(1);
});
