import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "esbuild";
import JSZip from "jszip";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../worker/reference-test-support";
import { snapshotFullExportV26 } from "../../worker/export-v26-snapshot";
import { buildFullExportInWorker } from "./full-export-worker-client";

let workerBundle: string;
const workers: BrowserWorker[] = [];
class BrowserWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly native: NodeWorker;
  terminated = false;
  stopped: Promise<number>;
  constructor(url: URL, options: WorkerOptions) {
    expect(url.pathname).toMatch(/\/src\/workers\/full-export\.worker\.ts$/);
    expect(options.type).toBe("module");
    this.native = new NodeWorker(`const { parentPort } = require('node:worker_threads');
      globalThis.postMessage = value => parentPort.postMessage(value);
      parentPort.on('message', data => globalThis.onmessage?.({ data }));
      ${workerBundle}`, { eval: true });
    this.stopped = new Promise(resolve => { this.native.once("exit", resolve); });
    this.native.on("message", data => this.onmessage?.({ data } as MessageEvent));
    this.native.on("error", () => this.onerror?.());
    this.native.on("messageerror", () => this.onmessageerror?.());
    workers.push(this);
  }
  postMessage(value: unknown) { this.native.postMessage(value); }
  terminate() { this.terminated = true; void this.native.terminate(); }
}
beforeAll(async () => {
  const result = await build({ entryPoints: [new URL("../workers/full-export.worker.ts", import.meta.url).pathname],
    bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });
  workerBundle = result.outputFiles[0].text;
});
afterEach(async () => {
  for (const worker of workers.splice(0)) { worker.terminate(); await worker.stopped; }
  vi.unstubAllGlobals();
});

describe("dedicated full export worker", () => {
  it("terminates the actual compression worker on cancellation and permits a new valid V26 archive", async () => {
    const database = referenceTestDatabase({ throughMigration: "0024_rt3_local_volume_profiles.sql" });
    try {
      database.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run("worker-export", "WORKER", "Worker export", "2026-10-20T12:00:00.000Z", "2026-10-20T12:00:00.000Z");
      const manifest = await snapshotFullExportV26(new SqliteD1Database(database) as unknown as D1Database);
      vi.stubGlobal("Worker", BrowserWorker);
      const controller = new AbortController(); let reachedCompression = false;
      const cancelled = buildFullExportInWorker(manifest, undefined, { signal: controller.signal,
        onStageProgress(progress) { if (progress.stage === "compressing") { reachedCompression = true; controller.abort(); } } });
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      expect(reachedCompression).toBe(true); expect(workers[0].terminated).toBe(true);
      await workers[0].stopped;

      const result = await buildFullExportInWorker(manifest);
      expect(workers).toHaveLength(2); expect(workers[1].terminated).toBe(true);
      const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
      const exported = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
      expect(exported.schemaVersion).toBe(26);
      expect(JSON.parse(await zip.file("tables/samples.json")!.async("string"))).toEqual(manifest.tables.samples);
      expect(result.warnings).toEqual([]);
      expect(JSON.stringify(exported)).not.toContain("downloadUrl");
    } finally { database.close(); }
  }, 20_000);
});
