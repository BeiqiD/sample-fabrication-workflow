import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "esbuild";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.unstubAllGlobals());
import { V26_NODE_INSTALLATION_CATALOG } from "../../server/installation-catalog-v26";
import { installReviewedSqliteCatalog } from "../../server/migrations";
import { createSqliteCapability } from "../../server/sqlite";
import { captureQuiescedNodeSystemBackupV26 } from "../../server/recovery/snapshot-v26";
import { exportAll } from "../../src/lib/exportAll";
import { restoreExportToIsolatedDirectory } from "./export-restore";

it("V26 public dispatcher: packages and restores actual non-empty V26 research bytes/rowids while excluding protected accounts and all installation authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portable-v26-research-"));
  const database = new DatabaseSync(join(directory, "source.sqlite")), core = createSqliteCapability(database);
  const workers: Array<{ native: NodeWorker; stopped: Promise<number>; terminated: boolean }> = [];
  try {
    installReviewedSqliteCatalog(database, V26_NODE_INSTALLATION_CATALOG);
    const at = "2026-10-10T12:00:00.000Z", payload = Uint8Array.of(0, 1, 255, 7);
    database.prepare("INSERT INTO samples(rowid,id,code,title,description,created_at,updated_at) VALUES(?,'retained','KEPT','Portable sample','Retained中文',?,?)")
      .run(-9223372036854775808n, at, at);
    database.prepare("INSERT INTO assets(rowid,id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(?,'original','retained/original','original.bin','application/octet-stream',4,'ready',?,?)")
      .run(9007199254740993n, createHash("sha256").update(payload).digest("hex"), at);
    database.prepare("INSERT INTO events(rowid,id,sample_id,kind,body,asset_key,metadata_json,created_at) VALUES(?,'retained-event','retained','image','Retained event','retained/original','{}',?)")
      .run(9007199254740993n, at);
    const verifier = "protected-research-archive-must-not-contain-this-verifier";
    database.prepare("INSERT INTO local_accounts VALUES('local_10000000-0000-4000-8000-000000000001','retained.admin',?,1,1,0)").run(verifier);
    const content = (await captureQuiescedNodeSystemBackupV26(core, database, { backupId: "research-only", createdAt: at })).content;
    const fetched: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const address = String(input); fetched.push(address);
      if (address === "/api/exports/all?archiveSchema=26&archiveWriter=1") return Response.json(content);
      expect(content.blobs.some(blob => blob.downloadUrl === address)).toBe(true);
      return new Response(payload.slice().buffer);
    });
    vi.stubGlobal("fetch", fetchMock);
    // exportAll is the browser entry point and now requires an interruptible
    // dedicated worker. Run that exact bundled worker in a real host thread;
    // only its browser fetch transport crosses to this existing route fixture.
    const bundled = await build({ entryPoints: [new URL("../../src/workers/full-export.worker.ts", import.meta.url).pathname],
      bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent" });
    class BrowserWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      readonly native: NodeWorker;
      readonly stopped: Promise<number>;
      terminated = false;
      constructor(url: URL, options: WorkerOptions) {
        expect(url.pathname).toMatch(/\/src\/workers\/full-export\.worker\.ts$/);
        expect(options).toMatchObject({ type: "module", name: "full-content-export" });
        this.native = new NodeWorker(`const { parentPort } = require('node:worker_threads');
          let sequence=0;const pending=new Map();
          globalThis.postMessage=value=>parentPort.postMessage(value);
          globalThis.fetch=(input,init)=>new Promise((resolve,reject)=>{
            const id=++sequence;pending.set(id,{resolve,reject});
            parentPort.postMessage({type:'fixture-fetch',id,address:String(input),credentials:init?.credentials});
          });
          parentPort.on('message',data=>{
            if(data.type==='fixture-response'){
              const request=pending.get(data.id);if(!request)return;pending.delete(data.id);
              if(data.error)request.reject(new Error(data.error));
              else request.resolve(new Response(data.bytes,{status:data.status,headers:data.headers}));
            }else globalThis.onmessage?.({data});
          });
          ${bundled.outputFiles[0].text}`, { eval: true });
        this.stopped = new Promise(resolve => { this.native.once("exit", resolve); });
        this.native.on("message", (data: { type: string; id?: number; address?: string; credentials?: RequestCredentials }) => {
          if (data.type !== "fixture-fetch") { this.onmessage?.({ data } as MessageEvent); return; }
          void (async () => {
            try {
              const response = await fetch(data.address!, { credentials: data.credentials });
              const bytes = await response.arrayBuffer();
              if (!this.terminated) this.native.postMessage({ type: "fixture-response", id: data.id,
                status: response.status, headers: [...response.headers], bytes }, [bytes]);
            } catch (error) {
              if (!this.terminated) this.native.postMessage({ type: "fixture-response", id: data.id,
                error: error instanceof Error ? error.message : "Fixture route failed" });
            }
          })();
        });
        this.native.on("error", () => this.onerror?.());
        this.native.on("messageerror", () => this.onmessageerror?.());
        workers.push(this);
      }
      postMessage(value: unknown) { this.native.postMessage(value); }
      terminate() { this.terminated = true; void this.native.terminate(); }
    }
    vi.stubGlobal("Worker", BrowserWorker);
    const built = await exportAll();
    expect(workers).toHaveLength(1); expect(workers[0].terminated).toBe(true);
    expect(fetched[0]).toBe("/api/exports/all?archiveSchema=26&archiveWriter=1");
    expect(built.warnings).toEqual([]); expect(fetched).toHaveLength(2);
    const bytes = Buffer.from(await built.archive.arrayBuffer()), zip = await JSZip.loadAsync(bytes);
    const archived = JSON.parse(await zip.file("export-manifest.json")!.async("string"));
    expect(archived.schemaVersion).toBe(26);
    const sourceRowids = JSON.parse(await zip.file(archived.artifacts.sourceRowids.path)!.async("string"));
    expect(sourceRowids.tables.events).toEqual([
      expect.objectContaining({ rowid: "9007199254740993" }),
    ]);
    expect(Object.keys(archived.tables).some(name => name.startsWith("local_") || name.startsWith("node_"))).toBe(false);
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir && /\.json$/.test(entry.name)) expect(await entry.async("string")).not.toContain(verifier);
    }
    expect(zip.file("artifacts/portable-runtime-checkpoint.json")).not.toBeNull();
    const archivePath = join(directory, "research.zip"); await writeFile(archivePath, bytes);
    const result = await restoreExportToIsolatedDirectory({ archivePath, destination: join(directory, "research-restored"),
      migrationsDirectory: new URL("../../migrations/", import.meta.url).pathname, targetCompatibilitySchema: "S2" });
    const restored = new DatabaseSync(join(result.restoredDirectory, "database.sqlite"));
    try {
      // Research provenance preserves physical IDs for File consumer tables;
      // samples retain their canonical stable ID, not an unexported rowid.
      expect(restored.prepare("SELECT id,title,description FROM samples WHERE id='retained'").get())
        .toEqual({ id: "retained", title: "Portable sample", description: "Retained中文" });
      expect(restored.prepare("SELECT CAST(rowid AS TEXT) rowid,id,body FROM events WHERE id='retained-event'").get())
        .toEqual({ rowid: "9007199254740993", id: "retained-event", body: "Retained event" });
      expect(restored.prepare("SELECT id,r2_key,original_name,byte_size FROM assets WHERE id='original'").get())
        .toEqual({ id: "original", r2_key: "retained/original", original_name: "original.bin", byte_size: 4 });
      expect(restored.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name GLOB 'local_*' OR name GLOB 'node_*')").all()).toEqual([]);
      expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { restored.close(); }
    const providers = JSON.parse(await readFile(join(result.restoredDirectory, "provider-manifest.json"), "utf8"));
    const blobPath = providers.find((blob: { outcome: string }) => blob.outcome === "packaged").path;
    expect(await readFile(join(result.restoredDirectory, blobPath))).toEqual(Buffer.from(payload));
    expect(await readFile(archivePath)).toEqual(bytes);
  } finally {
    for (const worker of workers) { void worker.native.terminate(); await worker.stopped; }
    core.close(); await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
