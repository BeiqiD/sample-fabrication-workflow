import { FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-file-runtime";
import { FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-file-shadow-adjudications";
import { FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256 } from "../../shared/contracts/export-file-shadow-withdrawals";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { stableJson } from "../../shared/domain/content-addressing";
import { FILE_SHADOW_HEAD_INTEGRITY_SQL } from "../../shared/contracts/export-file-shadow";
import { isFileShadowRowid } from "../../shared/contracts/file-shadow-rowid";
import { readShadowBaseline, type ShadowBaseline } from "../../worker/files/shadow-baseline";
import { MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES, type LiveConsumerKey } from "../../worker/files/live-consumer-baseline";

export const MAX_FILE_SHADOW_INSPECTION_CONSUMERS = 1000;
export const MAX_FILE_SHADOW_INSPECTION_HEADS = 20_000;
export const MAX_FILE_SHADOW_INSPECTION_BYTES = 8 * 1024 * 1024;

// Only fixed classifications may leave this inspector. Never copy an operation
// error, admission reason, actor, receipt, namespace or provider address.
const REASONS = new Set([
  "event_locator_semantics_invalid", "consumer_unavailable_without_locator", "registry_record_missing", "consumer_has_no_locator",
  "consumer_generation_unfinished", "consumer_parent_missing", "unsupported_legacy_provider", "legacy_locator_requires_explicit_resolution",
  "conflicting_registry_bindings", "legacy_registry_not_ready", "legacy_lifecycle_blocks_verification", "unexpected_existing_file_binding",
  "expected_byte_metadata_incomplete", "expected_byte_metadata_conflict", "acceptance_unfinished", "accepted_result_invalid",
  "accepted_registry_identity_mismatch", "consumer_purpose_unresolved", "recorded_purpose_conflict", "derivation_not_assessed",
  "shared_locator_purpose_unresolved", "independent_verified_copies_required", "namespace_evidence_missing", "namespace_evidence_invalid",
  "namespace_conflict", "namespace_revision_mismatch", "source_exceeds_verified_byte_limit", "source_profile_unresolved",
  "published_location_unusable",
]);
const UNFINISHED = ["staged", "write_started", "unknown", "verified"] as const;

export interface FileShadowInspectionRecord {
  key: LiveConsumerKey;
  occurrenceId: string;
  generation: number;
  sourceRowid: string;
  purpose: ShadowBaseline["purpose"];
  baselineSha256: string;
  recordedDecision: "resolved" | "admitted_unresolved" | null;
  state: "resolved" | "admitted_unresolved" | "pending";
  metadataStatus: ShadowBaseline["status"];
  reasons: string[];
}

function boundedCount(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Shadow ${label} bound exceeded`);
  }
  return value;
}

async function assertClosedSnapshot(path: string) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { await lstat(`${path}${suffix}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Database has SQLite sidecars; use a closed SQLite backup snapshot");
  }
}

function readOnlyAdapter(database: DatabaseSync) {
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind(...bindings: unknown[]) { return prepare(sql, bindings as SQLInputValue[]); },
    async all<T>() { return { success: true, results: database.prepare(sql).all(...values) as T[] }; },
  });
  return { prepare };
}

async function publishNewReport(path: string, content: string) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Output already exists; choose a new report path");
      throw error;
    }
  } finally { await rm(temporary, { force: true }); }
}

async function readInspection(database: DatabaseSync) {
  const adapter = readOnlyAdapter(database);
  // Empty kind cannot name a V15 head. The same baseline reader therefore
  // validates the schema fingerprint, rowid claims, global source row/key
  // bounds, authority and runtime even when there are no current consumers.
  const installation = await readShadowBaseline(adapter, { consumerKind: "", consumerId: "", consumerSubId: "", fileSlot: "" });
  const enablement = database.prepare("SELECT enabled_at FROM file_shadow_enablements WHERE singleton=1").get();
  if (installation.head || installation.record || installation.status !== "absent"
    || installation.authority.mode === "legacy" && (installation.authority.activated_at !== null || enablement !== undefined)
    || installation.authority.mode === "overlap" && (typeof installation.authority.activated_at !== "string"
      || installation.authority.activated_at !== enablement?.enabled_at)
    || installation.runtime.enabled === 1 && installation.authority.mode !== "overlap") {
    throw new Error("Invalid shadow installation snapshot");
  }

  const measured = database.prepare(`SELECT count(*) total, COALESCE(sum(present=1),0) present,
    COALESCE(sum(length(CAST(consumer_kind AS BLOB))+length(CAST(consumer_id AS BLOB))
      +length(CAST(consumer_sub_id AS BLOB))+length(CAST(file_slot AS BLOB))),0) key_bytes
    FROM (SELECT consumer_kind,consumer_id,consumer_sub_id,file_slot,present FROM file_shadow_heads LIMIT ?)`)
    .get(MAX_FILE_SHADOW_INSPECTION_HEADS + 1)!;
  const allHeads = boundedCount(measured.total, MAX_FILE_SHADOW_INSPECTION_HEADS, "head count");
  const presentHeads = boundedCount(measured.present, MAX_FILE_SHADOW_INSPECTION_CONSUMERS, "consumer count");
  boundedCount(measured.key_bytes, MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES, "head key byte");
  if (database.prepare(FILE_SHADOW_HEAD_INTEGRITY_SQL).get()?.invalid_count !== 0
    || database.prepare(`SELECT 1 FROM file_shadow_heads h LEFT JOIN file_shadow_occurrences o ON o.id=h.occurrence_id
      WHERE o.id IS NULL OR h.consumer_kind IS NOT o.consumer_kind OR h.consumer_id IS NOT o.consumer_id
        OR h.consumer_sub_id IS NOT o.consumer_sub_id OR h.file_slot IS NOT o.file_slot
        OR h.generation IS NOT o.generation OR h.present IS NOT o.present OR h.source_rowid IS NOT o.source_rowid
        OR h.source_json IS NOT o.source_json OR h.observed_epoch IS NOT o.observed_epoch LIMIT 1`).get()) {
    throw new Error("Shadow source/head coverage mismatch");
  }

  const heads = database.prepare(`SELECT h.consumer_kind,h.consumer_id,h.consumer_sub_id,h.file_slot,h.occurrence_id,h.generation,
      d.decision,CASE WHEN d.decision='resolved' AND f.file_id IS NOT NULL AND f.active_location_id=d.location_id THEN 1 ELSE 0 END usable
    FROM file_shadow_heads h LEFT JOIN file_shadow_decisions d ON d.occurrence_id=h.occurrence_id
    LEFT JOIN file_usable_publications f ON f.file_id=d.file_id WHERE h.present=1
    ORDER BY h.consumer_kind COLLATE BINARY,h.consumer_id COLLATE BINARY,h.consumer_sub_id COLLATE BINARY,h.file_slot COLLATE BINARY LIMIT ?`)
    .all(MAX_FILE_SHADOW_INSPECTION_CONSUMERS + 1);
  if (heads.length !== presentHeads) throw new Error("Shadow consumer inventory mismatch");
  const records: FileShadowInspectionRecord[] = [];
  const counts = { total: presentHeads, resolvedUsable: 0, admittedUnresolved: 0, pending: 0, readyToVerify: 0 };
  const reasonCounts: Record<string, number> = {};
  let recordBytes = 0;
  for (const row of heads) {
    const key = { consumerKind: row.consumer_kind, consumerId: row.consumer_id, consumerSubId: row.consumer_sub_id, fileSlot: row.file_slot } as LiveConsumerKey;
    const baseline = await readShadowBaseline(adapter, key);
    if (!baseline.head || !baseline.record || baseline.head.present !== 1 || baseline.status === "absent"
      || baseline.head.occurrence_id !== row.occurrence_id || baseline.head.generation !== row.generation
      || baseline.epoch !== installation.epoch || !isFileShadowRowid(baseline.head.source_rowid)) {
      throw new Error("Shadow current consumer baseline mismatch");
    }
    const recordedDecision = baseline.decision?.decision ?? null;
    if (recordedDecision !== row.decision || recordedDecision !== null && !["resolved", "admitted_unresolved"].includes(recordedDecision)) {
      throw new Error("Invalid shadow recorded decision");
    }
    const state = row.usable === 1 ? "resolved" : recordedDecision === "admitted_unresolved" ? "admitted_unresolved" : "pending";
    const reasons = [...new Set([...baseline.reasons,
      ...(recordedDecision === "resolved" && state === "pending" ? ["published_location_unusable"] : [])])].sort();
    if (reasons.some((reason) => !REASONS.has(reason))) throw new Error("Unsupported shadow classification reason");
    for (const reason of reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    if (state === "resolved") counts.resolvedUsable += 1;
    else if (state === "admitted_unresolved") counts.admittedUnresolved += 1;
    else {
      counts.pending += 1;
      if (baseline.status === "ready_to_verify") counts.readyToVerify += 1;
    }
    const record: FileShadowInspectionRecord = { key: baseline.key, occurrenceId: baseline.head.occurrence_id,
      generation: baseline.head.generation, sourceRowid: baseline.head.source_rowid, purpose: baseline.purpose,
      baselineSha256: baseline.baselineSha256, recordedDecision, state, metadataStatus: baseline.status, reasons };
    recordBytes += Buffer.byteLength(stableJson(record), "utf8");
    if (recordBytes > MAX_FILE_SHADOW_INSPECTION_BYTES) throw new Error("Shadow report byte bound exceeded");
    records.push(record);
  }

  // Recovery inventory includes historical occurrences and expired leases.
  // Lease expiry and absence of a current head do not prove a write finished.
  const byState = { staged: 0, write_started: 0, unknown: 0, verified: 0 };
  for (const row of database.prepare(`SELECT state,count(*) count FROM file_shadow_attempts
    WHERE state IN ('staged','write_started','unknown','verified') GROUP BY state`).all()) {
    if (!UNFINISHED.includes(row.state as typeof UNFINISHED[number])) throw new Error("Invalid shadow unfinished state");
    byState[row.state as typeof UNFINISHED[number]] = boundedCount(row.count, Number.MAX_SAFE_INTEGER, "unfinished attempt count");
  }
  const unfinishedAttempts = { total: boundedCount(Object.values(byState).reduce((a, b) => a + b, 0), Number.MAX_SAFE_INTEGER, "unfinished attempt count"), byState };
  const pendingOperations = boundedCount(database.prepare("SELECT count(*) count FROM file_shadow_operations WHERE status='pending'").get()?.count,
    Number.MAX_SAFE_INTEGER, "pending operation count");
  return { version: 1 as const, kind: "file-shadow-inspection" as const, schemaVersion: installation.schemaSha256 === FILE_AUTHORITY_RUNTIME_SCHEMA_FINGERPRINT_SHA256 ? 18 as const : installation.schemaSha256 === FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256 ? 17 as const : installation.schemaSha256 === FILE_SHADOW_WITHDRAWAL_SCHEMA_FINGERPRINT_SHA256 ? 16 as const : 15 as const,
    schemaSha256: installation.schemaSha256, executable: false as const, providerIO: false as const,
    bytesVerified: false as const, activationReady: false as const,
    authority: { mode: installation.authority.mode, revision: installation.authority.revision }, epoch: installation.epoch,
    runtime: { enabled: installation.runtime.enabled === 1 }, headCounts: { all: allHeads, present: presentHeads, absent: allHeads - presentHeads },
    counts, reasonCounts, unfinishedAttempts, pendingOperations, records };
}

/** Inspect one closed rollback-journal SQLite backup. Every observation is read
 * in one read-only transaction. Metadata eligibility is neither byte proof nor
 * an executable conversion plan, checkpoint, live lease or activation gate. */
export async function inspectFileShadowSnapshot(input: { databasePath: string; outputPath: string }) {
  const databasePath = await realpath(resolve(input.databasePath));
  const requestedOutput = resolve(input.outputPath);
  await mkdir(dirname(requestedOutput), { recursive: true });
  const outputPath = resolve(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  if (databasePath === outputPath || ["-wal", "-shm", "-journal"].some((suffix) => outputPath === `${databasePath}${suffix}`)) {
    throw new Error("Database and report output must be different paths");
  }
  await assertClosedSnapshot(databasePath);
  const file = await open(databasePath, constants.O_RDONLY | constants.O_NONBLOCK);
  let database: DatabaseSync | undefined;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Database input must be a regular SQLite file");
    const header = Buffer.alloc(100);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0") {
      throw new Error("Database input must be a SQLite database");
    }
    if (header[18] !== 1 || header[19] !== 1) throw new Error("WAL databases require a closed SQLite backup snapshot before inspection");
    database = new DatabaseSync(databasePath, { readOnly: true, enableForeignKeyConstraints: true, allowExtension: false });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN");
    const report = await readInspection(database);
    database.exec("ROLLBACK");
    database.close(); database = undefined;
    const [after, current] = await Promise.all([file.stat({ bigint: true }), lstat(databasePath, { bigint: true })]);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Database snapshot changed during inspection; take a fresh SQLite backup");
    }
    await assertClosedSnapshot(databasePath);
    const encoded = `${stableJson(report)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_FILE_SHADOW_INSPECTION_BYTES) throw new Error("Shadow report byte bound exceeded");
    await publishNewReport(outputPath, encoded);
    return { outputPath, reportSha256: createHash("sha256").update(encoded).digest("hex"), executable: false as const,
      providerIO: false as const, bytesVerified: false as const, activationReady: false as const,
      counts: report.counts, unfinishedAttempts: report.unfinishedAttempts, pendingOperations: report.pendingOperations };
  } finally { try { database?.close(); } finally { await file.close(); } }
}
