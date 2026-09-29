import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../shared/content-addressing";
import { futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";
import worker from "../index";
import { SqliteD1Database } from "../reference-test-support";
import { FABUBLOX_IMPORT_LEASE_MS, reapStaleFabubloxImports } from "../fabublox-import-recovery";
import type { Env } from "../types";

const namespace = JSON.stringify({ kind: "local-r2", installationId: "c6a96dbb-7d68-4cfa-8ce4-74d5817699da", bucketName: "authority-imports" });
const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const databases: ReturnType<typeof futureActiveRuntimeDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(sql => sql.close()));

async function importForm() {
  const manifest = { schemaVersion: 2, title: "File authority import",
    source: { fileName: "source.xlsx", fileSha256: await sha256Hex(bytes.buffer), sheetName: "Process" },
    initialSubstrateStep: null, initialStateImageIds: [], warnings: [],
    steps: [{ localId: "step", sourceRow: 2, position: 0, stepNumber: "1", sectionName: null,
      name: "Etch", toolName: null, parametersText: null, commentsText: null, imageIds: ["image"], rawCells: {} }],
    images: [{ localId: "image", sourcePart: "xl/media/image.png", mimeType: "image/png", assignedStepLocalId: "step", anchor: {} }],
  };
  const form = new FormData();
  form.set("workbook", new File([bytes], "source.xlsx"));
  form.set("manifest", new File([JSON.stringify(manifest)], "manifest.json", { type: "application/json" }));
  form.set("image:image", new File([bytes], "image.png", { type: "image/png" }));
  return form;
}

function fixture(loseAck = false, interruption: "before-finalization" | "after-finalization" | null = null) {
  const now = new Date().toISOString();
  const sql = futureActiveRuntimeDatabase(db => {
    db.prepare("INSERT INTO storage_profiles VALUES('import-profile','r2',?,'bootstrap',NULL,1,'historical',?)").run(namespace, now);
    db.prepare("INSERT INTO file_shadow_profile_enablements VALUES('import-profile',1,'operator',?)").run(now);
  });
  databases.push(sql);
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, body: BodyInit) => {
    expect(sql.prepare("SELECT state FROM file_acceptance_candidates WHERE candidate_object_key=?").get(key)?.state).toBe("candidate");
    stored.set(key, new Uint8Array(await new Response(body).arrayBuffer()));
  });
  const get = vi.fn(async (key: string) => {
    const value = stored.get(key);
    return value ? { body: new Response(value).body!, size: value.length, httpEtag: '"import"', writeHttpMetadata() {} } : null;
  });
  const adapter = new SqliteD1Database(sql);
  let databaseUnavailable = false;
  const db = { prepare(query: string) {
    if (databaseUnavailable) throw new Error("Database connection interrupted");
    return adapter.prepare(query);
  }, async batch(statements: D1PreparedStatement[]) {
    if (interruption === "before-finalization" && sql.prepare(`SELECT 1 FROM template_steps ts
      JOIN imports i ON i.template_version_id=ts.template_version_id WHERE i.status='pending'`).get()) {
      interruption = null;
      databaseUnavailable = true;
      throw new Error("Executor disconnected before finalization");
    }
    const result = await adapter.batch(statements);
    if (interruption === "after-finalization" && sql.prepare("SELECT 1 FROM imports WHERE status='ready'").get()) {
      interruption = null;
      databaseUnavailable = true;
      throw new Error("Executor disconnected after finalization");
    }
    if (loseAck && sql.prepare("SELECT 1 FROM imports WHERE status='ready'").get()) {
      loseAck = false;
      throw new Error("Lost finalization acknowledgement");
    }
    return result;
  } } as unknown as D1Database;
  const env = { AUTH_MODE: "disabled", DB: db, R2_BOOTSTRAP_NAMESPACE: namespace,
    ASSETS: { get, head: get, put, delete: vi.fn() } as unknown as R2Bucket } satisfies Env;
  const requestId = crypto.randomUUID();
  const upload = async () => worker.fetch(new Request("https://app.test/api/imports/fabublox", {
    method: "POST", headers: { "X-Import-Request-Id": requestId }, body: await importForm(),
  }), env, context);
  return { sql, put, get, stored, upload, env, reconnect() { databaseUnavailable = false; } };
}

describe("active accepted import File publication", () => {
  it("publishes every typed file atomically, separates equal bytes by purpose, and reconciles lost ACK without another PUT", async () => {
    const f = fixture(true);
    const response = await f.upload(), result = await response.json() as { templateVersionId: string };
    expect(response.status, JSON.stringify(result)).toBe(201);
    expect(f.put).toHaveBeenCalledTimes(3);
    expect(f.sql.prepare("SELECT item_id,state FROM file_acceptance_candidates ORDER BY item_id").all()).toEqual([
      { item_id: "image:image", state: "ready" }, { item_id: "manifest", state: "ready" }, { item_id: "workbook", state: "ready" },
    ]);
    expect(f.sql.prepare("SELECT purpose,count(*) n FROM file_publications GROUP BY purpose ORDER BY purpose").all())
      .toEqual([{ purpose: "embedded_content", n: 1 }, { purpose: "provenance", n: 2 }]);
    const receipt = f.sql.prepare("SELECT status,workbook_file_id,manifest_file_id FROM imports").get()!;
    expect(receipt.status).toBe("ready");
    expect(f.sql.prepare("SELECT source_file_id FROM template_versions WHERE id=?").get(result.templateVersionId)!.source_file_id).toBe(receipt.workbook_file_id);
    expect(f.sql.prepare("SELECT file_id FROM state_representation_assets").get()!.file_id).toBeTruthy();
    const reads = f.get.mock.calls.length;
    const replay = await f.upload(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(result);
    expect(f.put).toHaveBeenCalledTimes(3); expect(f.get).toHaveBeenCalledTimes(reads);
    const cloned = await worker.fetch(new Request(`https://app.test/api/templates/${result.templateVersionId}/clone`, {
      method: "POST",
    }), f.env, context);
    const clone = await cloned.json() as { id: string };
    expect(cloned.status, JSON.stringify(clone)).toBe(201);
    expect(f.sql.prepare("SELECT source_file_id FROM template_versions WHERE id=?").get(clone.id)!.source_file_id)
      .toBe(receipt.workbook_file_id);
    expect(f.put).toHaveBeenCalledTimes(3);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls publications and typed bindings back when the original import completion fails", async () => {
    const f = fixture();
    f.sql.exec("CREATE TRIGGER reject_import BEFORE UPDATE OF status ON imports WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'test import completion rejected'); END;");
    expect((await f.upload()).status).toBe(500);
    for (const table of ["file_location_publications", "file_publications", "assets", "state_representation_assets"]) {
      expect(f.sql.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
    }
    expect(f.sql.prepare("SELECT source_file_id FROM template_versions").get()!.source_file_id).toBeNull();
    expect(f.sql.prepare("SELECT status,recovery_operation_id,lease_expires_at FROM imports").get())
      .toEqual({ status: "failed", recovery_operation_id: expect.any(String), lease_expires_at: null });
    expect(f.sql.prepare("SELECT deleted_at FROM template_versions WHERE id=(SELECT template_version_id FROM imports)").get()!.deleted_at).toBeTruthy();
    expect(f.stored.size).toBe(3); expect(f.env.ASSETS.delete).not.toHaveBeenCalled();
    expect((await f.upload()).status).toBe(409); expect(f.put).toHaveBeenCalledTimes(3);
  });

  it("recovers an interrupted private import without provider access or moving candidate ownership", async () => {
    const f = fixture(false, "before-finalization");
    expect((await f.upload()).status).toBe(503);
    const candidates = f.sql.prepare("SELECT * FROM file_acceptance_candidates ORDER BY item_id").all();
    expect(candidates).toHaveLength(3);
    expect(f.sql.prepare("SELECT status FROM imports").get()!.status).toBe("pending");
    f.reconnect();
    const providerReads = f.get.mock.calls.length;
    f.get.mockRejectedValue(new Error("Provider unavailable"));
    f.env.R2_BOOTSTRAP_NAMESPACE = namespace.replace("authority-imports", "different-installation");
    const future = new Date(Date.now() + FABUBLOX_IMPORT_LEASE_MS + 1_000);
    expect(await reapStaleFabubloxImports(f.env, future)).toEqual({
      staleImportsFailed: 1, staleImportAssetsReleased: 0,
      staleImportObjectsQueued: 0, staleImportRecoveryFailures: 0,
    });
    expect(f.sql.prepare("SELECT * FROM file_acceptance_candidates ORDER BY item_id").all()).toEqual(candidates);
    expect(f.sql.prepare("SELECT status,recovery_operation_id,lease_expires_at FROM imports").get())
      .toEqual({ status: "failed", recovery_operation_id: expect.any(String), lease_expires_at: null });
    expect(f.sql.prepare("SELECT deleted_at,source_file_id FROM template_versions WHERE id=(SELECT template_version_id FROM imports)").get())
      .toEqual({ deleted_at: future.toISOString(), source_file_id: null });
    expect(f.sql.prepare("SELECT count(*) n FROM template_steps WHERE template_version_id=(SELECT template_version_id FROM imports)").get()!.n).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM blob_gc_ledger").get()!.n).toBe(0);
    expect((await f.upload()).status).toBe(409);
    expect((await reapStaleFabubloxImports(f.env, future)).staleImportsFailed).toBe(0);
    expect(f.put).toHaveBeenCalledTimes(3);
    expect(f.get).toHaveBeenCalledTimes(providerReads);
    expect(f.env.ASSETS.delete).not.toHaveBeenCalled();
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps a committed import intact when both finalization acknowledgement and readback were lost", async () => {
    const f = fixture(false, "after-finalization");
    expect((await f.upload()).status).toBe(503);
    const receipt = f.sql.prepare("SELECT * FROM imports").get();
    const candidates = f.sql.prepare("SELECT * FROM file_acceptance_candidates ORDER BY item_id").all();
    f.reconnect();
    const reads = f.get.mock.calls.length;
    expect((await reapStaleFabubloxImports(f.env, new Date(Date.now() + FABUBLOX_IMPORT_LEASE_MS + 1_000))).staleImportsFailed).toBe(0);
    expect((await f.upload()).status).toBe(200);
    expect(f.sql.prepare("SELECT * FROM imports").get()).toEqual(receipt);
    expect(f.sql.prepare("SELECT * FROM file_acceptance_candidates ORDER BY item_id").all()).toEqual(candidates);
    expect(f.sql.prepare("SELECT deleted_at FROM template_versions WHERE id=(SELECT template_version_id FROM imports)").get()!.deleted_at).toBeNull();
    expect(f.put).toHaveBeenCalledTimes(3); expect(f.get).toHaveBeenCalledTimes(reads);
    expect(f.env.ASSETS.delete).not.toHaveBeenCalled();
  });
});
