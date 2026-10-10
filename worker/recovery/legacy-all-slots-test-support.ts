import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { historicalReferenceTestDatabase, seedHistoricalReferenceGraph, SqliteD1Database } from "../reference-test-support";
import { snapshotFullExportV8 } from "../export-v8-snapshot";
import { buildFullExportArchiveV8 } from "../../src/lib/exportAll";
import { convertLegacySystemBackup } from "../../scripts/lib/convert-system-backup";
import { hashStateRepresentation, stableJson } from "../../shared/domain/content-addressing";
import type { SystemBackupManifestV1, SystemBackupRecordsV1 } from "../../shared/contracts/system-backup";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const at = "2026-10-06T12:00:00.000Z", actor = "legacy-owner@example.test";

/** A real historical S0 database and V8 browser archive populate every legacy
 * File-consumer slot. No current acceptance or provider capability is invented.
 * The isolated converter retains the original archive and retired-field values. */
export async function convertedLegacyAllSlotsFixture(directory: string, options: { mediaReadCases?: boolean } = {}) {
  const source = historicalReferenceTestDatabase(), payloads = new Map<string, Uint8Array>();
  let legacyArchiveBytes: Uint8Array, historical: Awaited<ReturnType<typeof snapshotFullExportV8>>;
  try {
    seedHistoricalReferenceGraph(source);
    source.exec("UPDATE samples SET process_revision=37 WHERE id='reference-sample-a'; UPDATE run_step_comments SET body='Exact retired duplicate 中文' WHERE id='reference-comment-occurrence-a'");
    for (const asset of source.prepare("SELECT id,r2_key,byte_size FROM assets").all()) {
      const bytes = new Uint8Array(Number(asset.byte_size)).fill(Number(asset.byte_size));
      payloads.set(String(asset.r2_key), bytes);
      source.prepare("UPDATE assets SET sha256=? WHERE id=?").run(sha(bytes), asset.id);
    }
    const asset = (name: string, mediaType = "image/png") => {
      const bytes = new TextEncoder().encode(`Exact legacy ${name} bytes 中文`), id = `legacy-${name}-asset`, key = `legacy/${name}`;
      source.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES(?,?,?,?,?,'ready',?,?)")
        .run(id, key, `${name}.bin`, mediaType, bytes.length, sha(bytes), at);
      payloads.set(key, bytes); return { id, key, bytes, sha256: sha(bytes) };
    };
    const state = asset("state"), occurrence = asset("occurrence"), evidence = asset("evidence"), project = asset("project"),
      preview = asset("preview"), event = asset("event"), thumbnail = asset("thumbnail"),
      workbook = asset("workbook", "application/octet-stream"), manifest = asset("manifest", "application/json"), recipe = asset("recipe", "application/octet-stream");
    if (options.mediaReadCases) {
      // Actual old installations admitted ready aliases with no stored SHA.
      // Recovery must obtain its hash from verified bytes, including aliases
      // with no relational consumer to provide a separate File read path.
      const orphan = asset("unconsumed");
      source.prepare("UPDATE assets SET sha256=NULL WHERE id IN(?,?)").run(occurrence.id, orphan.id);
    }
    const diagram = await hashStateRepresentation([state.sha256]);
    source.prepare("INSERT INTO state_representations(hash,content_json,created_at) VALUES(?,?,?)").run(diagram.hash, stableJson(diagram.canonical), at);
    source.prepare("INSERT INTO state_representation_assets(state_hash,asset_id,position) VALUES(?,?,0)").run(diagram.hash, state.id);
    source.prepare("INSERT INTO run_step_comments(id,run_step_id,scope,body,asset_id,created_at) VALUES('legacy-occurrence','reference-step-a','individual','Preserved legacy body',?,?)").run(occurrence.id, at);
    source.prepare("INSERT INTO state_verifications(id,sample_id,after_run_step_id,result,evidence_asset_id,created_at) VALUES('legacy-verification','reference-sample-a','reference-step-a','matched',?,?)").run(evidence.id, at);
    source.prepare("INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('legacy-project','Legacy Project','legacy-create',?,?,?,?)").run(actor, actor, at, at);
    source.prepare("INSERT INTO project_contents(id,project_id,content_type,last_mutation_id,created_by,updated_by,created_at,updated_at) VALUES('legacy-project-content','legacy-project','attachment','legacy-content-create',?,?,?,?)").run(actor, actor, at, at);
    source.prepare("INSERT INTO project_content_attachments(project_content_id,asset_id,original_name,mime_type,byte_size,created_by,created_at,creation_operation_id) VALUES('legacy-project-content',?,'project.bin','image/png',?,?,?,'legacy-attachment-create')").run(project.id, project.bytes.length, actor, at);
    source.prepare("INSERT INTO attachment_derivatives(id,source_sha256,source_byte_size,derivative_kind,generator_version,derived_asset_id,status,retain_until,created_at,updated_at) VALUES('legacy-preview',?,?,'browser_preview','legacy-preview/1',?,'ready','2099-10-06T12:00:00.000Z',?,?)")
      .run(event.sha256, event.bytes.length, preview.id, at, at);
    source.prepare("INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at) VALUES('legacy-event','reference-sample-a','image',?,?,?)")
      .run(event.key, JSON.stringify({ thumbnailKey: thumbnail.key, action: "sample_record", caption: "Original legacy event" }), at);
    source.prepare("INSERT INTO imports(id,status,source_filename,source_sha256,sheet_name,template_type,workbook_asset_key,manifest_asset_key,created_at) VALUES('legacy-import','ready','workbook.xlsx',?,'Legacy source','process',?,?,?)")
      .run(workbook.sha256, workbook.key, manifest.key, at);
    source.prepare("UPDATE template_versions SET source_asset_key=?,source_filename='recipe.xlsx' WHERE id='reference-process-template'").run(recipe.key);
    if (source.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid legacy all-slot fixture");
    historical = await snapshotFullExportV8(new SqliteD1Database(source) as unknown as D1Database);
    const built = await buildFullExportArchiveV8(historical, undefined, async input => {
      const locator = historical.blobs.find(blob => blob.downloadUrl === String(input));
      const bytes = locator ? payloads.get(locator.objectKey) : undefined;
      return new Response(bytes?.slice(0) ?? null, { status: bytes ? 200 : 404 });
    });
    if (built.warnings.length) throw new Error("Legacy all-slot archive failed byte qualification");
    legacyArchiveBytes = new Uint8Array(await built.archive.arrayBuffer());
  } finally { source.close(); }
  const archivePath = join(directory, "legacy-all-slots.zip"); await writeFile(archivePath, legacyArchiveBytes);
  const converted = await convertLegacySystemBackup({ archivePath, destination: join(directory, "converted-all-slots"),
    migrationsDirectory: fileURLToPath(new URL("../../migrations/", import.meta.url)) });
  const capsuleBytes = new Uint8Array(await readFile(converted.archivePath)), archive = await JSZip.loadAsync(capsuleBytes);
  const records = JSON.parse(await archive.file("records.json")!.async("string")) as SystemBackupRecordsV1;
  const manifest = JSON.parse(await archive.file("manifest.json")!.async("string")) as SystemBackupManifestV1;
  const capsulePayloads = new Map<string, Uint8Array>();
  for (const file of manifest.files) if (file.path) capsulePayloads.set(file.path, await archive.file(file.path)!.async("uint8array"));
  return { legacyArchiveBytes, historical, capsuleBytes, records, manifest, payloads, capsulePayloads, converted };
}
