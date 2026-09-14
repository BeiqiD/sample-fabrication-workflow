import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/content-addressing";
import type { FullExportManifestV11 as FullExportManifest } from "../shared/contracts/export";
import { buildFullExportArchiveV11 } from "../src/lib/exportAll";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import type { Env } from "./types";

const IMPORT_NAMESPACE = JSON.stringify({
  kind: "local-r2", installationId: "b72529f0-273b-4b72-9fc7-155a93461d83", bucketName: "fixture-assets",
});

const context = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function buffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function localEnvironment(database: ReturnType<typeof referenceTestDatabase>) {
  const stored = new Map<string, Uint8Array>();
  const read = vi.fn(async (key: string) => {
    const bytes = stored.get(key);
    return bytes ? {
      body: new Blob([buffer(bytes)]).stream(),
      size: bytes.byteLength,
      httpEtag: '"archive-fixture"',
      writeHttpMetadata(headers: Headers) { headers.set("content-type", "application/octet-stream"); },
    } : null;
  });
  const env: Env = {
    AUTH_MODE: "disabled",
      R2_BOOTSTRAP_NAMESPACE: IMPORT_NAMESPACE,
    DB: new SqliteD1Database(database) as unknown as D1Database,
    ASSETS: {
      get: read,
      head: read,
      put: async (key: string, value: BodyInit) => {
        stored.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
      },
      delete: async (key: string) => { stored.delete(key); },
      list: async () => ({ objects: [], truncated: false }),
    } as unknown as R2Bucket,
  };
  const request = (path: string, init?: RequestInit) => worker.fetch(
    new Request(`https://app.test${path}`, init), env, context,
  );
  return { request, stored, read };
}

async function importImages(
  request: ReturnType<typeof localEnvironment>["request"],
  imageIds: string[],
) {
  const workbook = new TextEncoder().encode("synthetic archive fixture workbook");
  const manifest = {
    schemaVersion: 2,
    title: "Archive identity fixture",
    source: { fileName: "fixture.xlsx", fileSha256: await sha256Hex(buffer(workbook)), sheetName: "Sheet1" },
    initialSubstrateStep: null,
    steps: [{
      localId: "step-1", sourceRow: 1, position: 0, stepNumber: "1",
      sectionName: null, name: "Fixture step", toolName: null,
      parametersText: null, commentsText: null, imageIds, rawCells: {},
    }],
    images: imageIds.map((localId) => ({
      localId, sourcePart: "fixture", mimeType: "image/png",
      assignedStepLocalId: "step-1", anchor: {},
    })),
    initialStateImageIds: [], warnings: [],
  };
  const form = new FormData();
  form.set("workbook", new File([buffer(workbook)], "fixture.xlsx"));
  form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", { type: "application/json" }));
  imageIds.forEach((id, index) => {
    form.set(`image:${id}`, new File([`synthetic image ${index}`], "image.png", { type: "image/png" }));
  });
  const response = await request("/api/imports/fabublox", { headers: { "X-Import-Request-Id": crypto.randomUUID() }, method: "POST", body: form });
  expect(response.status, await response.clone().text()).toBe(201);
}

describe("complete archive physical identity", () => {
  it("round-trips imported ASCII, Unicode, case and dot-segment locators through real export routes", async () => {
    const database = referenceTestDatabase();
    try {
      const { request, stored, read } = localEnvironment(database);
      const imageIds = ["foo bar", "foo_bar", "测试", "__", "Case", "case", "../foo", "nested/../foo", "nested/./foo"];
      await importImages(request, imageIds);
      expect(stored.size).toBe(imageIds.length + 2); // workbook and import manifest
      read.mockClear();

      const response = await request("/api/exports/all?archiveSchema=11&archiveWriter=1");
      expect(response.status).toBe(200);
      const manifest = await response.json() as FullExportManifest;
      const result = await buildFullExportArchiveV11(manifest, undefined,
        (async (url) => request(String(url))) as typeof fetch);
      expect(result.warnings).toEqual([]);
      expect(result.results).toHaveLength(stored.size);
      expect(result.results.every((entry) => entry.outcome === "packaged")).toBe(true);
      expect(read).toHaveBeenCalledTimes(stored.size);
      expect(new Set(read.mock.calls.map(([key]) => key))).toEqual(new Set(stored.keys()));

      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      const archivedManifest = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      expect(archivedManifest.schemaVersion).toBe(11);
      expect(archivedManifest.blobs).toEqual(result.results);
      expect(JSON.parse(await zip.file("export-warnings.json")!.async("string"))).toEqual([]);
      const paths = result.results.map((entry) => entry.path!);
      expect(new Set(paths.map((path) => path.toLowerCase())).size).toBe(stored.size);
      expect(Object.values(zip.files).filter((file) => !file.dir && file.name.startsWith("blobs/")))
        .toHaveLength(stored.size);

      // Recreate a separate provider map from archive contents, using only the
      // final manifest's exact locator and path. This is a byte round trip, not
      // a claim that the application implements full-database restore.
      const restored = new Map<string, Uint8Array>();
      for (const entry of result.results) {
        const bytes = await zip.file(entry.path!)!.async("uint8array");
        expect(bytes.byteLength).toBe(entry.expectedByteSize);
        expect(await sha256Hex(buffer(bytes)), entry.objectKey).toBe(entry.expectedSha256);
        expect(entry.path!.split("/")).not.toContain("..");
        restored.set(entry.objectKey, bytes);
      }
      expect(restored).toEqual(stored);
      for (const [name, rows] of Object.entries(manifest.tables)) {
        expect(JSON.parse(await zip.file(archivedManifest.tables[name].path)!.async("string"))).toEqual(rows);
      }
      const afterExport = await request("/api/exports/all?archiveSchema=11&archiveWriter=1");
      expect((await afterExport.json() as FullExportManifest).tables).toEqual(manifest.tables);
    } finally {
      database.close();
    }
  });

  it("keeps managed objects distinct when record IDs or display names sanitize identically", async () => {
    const database = referenceTestDatabase();
    try {
      const { request } = localEnvironment(database);
      const bytesById = new Map<string, Uint8Array>();
      const inputs = [
        ["object a", "file.bin"], ["object_a", "file.bin"],
        ["测试", "file.bin"], ["__", "file.bin"],
        ["dots", ".."], ["long-name", "x".repeat(300)],
      ];
      for (const [index, [id, filename]] of inputs.entries()) {
        const bytes = new TextEncoder().encode(`managed fixture ${index}`);
        bytesById.set(id, bytes);
        database.prepare(`INSERT INTO managed_storage_objects
          (id, provider, object_key, original_name, mime_type, byte_size, sha256, status, created_at)
          VALUES (?, 'switchdrive', ?, ?, 'application/octet-stream', ?, ?, 'ready', '2026-09-13T00:00:00Z')`)
          .run(id, `managed/key-${index}`, filename, bytes.byteLength, await sha256Hex(buffer(bytes)));
      }
      const response = await request("/api/exports/all?archiveSchema=11&archiveWriter=1");
      expect(response.status).toBe(200);
      const manifest = await response.json() as FullExportManifest;
      const result = await buildFullExportArchiveV11(manifest, undefined, (async (url) => {
        const id = decodeURIComponent(String(url).split("/").at(-1)!);
        const bytes = bytesById.get(id);
        return bytes ? new Response(buffer(bytes)) : new Response("", { status: 404 });
      }) as typeof fetch);
      expect(result.warnings).toEqual([]);
      const paths = result.results.map((entry) => entry.path!);
      expect(new Set(paths).size).toBe(inputs.length);
      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      for (const entry of result.results) {
        const bytes = await zip.file(entry.path!)!.async("uint8array");
        expect(bytes).toEqual(bytesById.get(entry.blobRecordIds[0]));
        expect(await sha256Hex(buffer(bytes))).toBe(entry.expectedSha256);
        expect(entry.path!.split("/").at(-1)!.length).toBeLessThan(200);
        expect(entry.path!).not.toMatch(/\.$/);
      }
    } finally {
      database.close();
    }
  });
});
