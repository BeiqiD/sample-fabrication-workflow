// QA-only stopped-state reader. Its Native ACK is not a physical/application ACK.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../../../server/migrations";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../../server/operational-installation-catalog";

interface Owner { nativeAttempted: boolean; nativeError?: unknown; native?: DatabaseSync;
  close?: () => void; closed?: boolean; closeError?: unknown; workError?: unknown }
const retained = new Set<Owner>();
async function main(): Promise<void> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { size += chunk.length; assert.ok(size <= 16384); chunks.push(Buffer.from(chunk)); }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  assert.deepEqual(Object.keys(value).sort(), ["database", "phase"]);
  assert.equal(value.database, "/var/lib/sample/state/application.sqlite");
  assert.ok(value.phase === "initialized" || value.phase === "completed");
  const owner: Owner = { nativeAttempted: false }; retained.add(owner);
  let workFailed = false, workError: unknown;
  try {
    owner.nativeAttempted = true;
    try { owner.native = new DatabaseSync(value.database as string,
      { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.nativeError = error; throw error; }
    const native = owner.native, original = native.close.bind(native);
    let attempted = false, failed = false, reason: unknown;
    owner.close = () => {
      if (attempted) { if (failed) throw reason; return; }
      attempted = true;
      try { original(); owner.closed = true; }
      catch (error) { failed = true; reason = owner.closeError = error; throw error; }
    };
    const admission = admitInstallationRecoverySource(native, OPERATIONAL_NODE_INSTALLATION_CATALOG);
    assert.equal(assertInstallationAdmission(native, admission).checkpointId, "portable-runtime/v26");
    assert.deepEqual(native.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check), ["ok"]);
    assert.deepEqual(native.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(native.prepare("SELECT mode FROM file_authority_control WHERE singleton=1").get()?.mode, "active");
    assert.equal(native.prepare("SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1").get()?.enabled, 1);
    assert.equal(native.prepare("SELECT enabled FROM file_job_runtime_guard WHERE singleton=1").get()?.enabled, 0);
    assert.equal(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n, 0);
    assert.equal(native.prepare("SELECT count(*) n FROM storage_role_defaults WHERE role IN('internal','originals')").get()?.n, 2);
    assert.equal(native.prepare("SELECT count(*) n FROM storage_profiles WHERE adapter_type='local'").get()?.n, 2);
    if (value.phase === "initialized") {
      assert.equal(native.prepare("SELECT count(*) n FROM file_migration_jobs").get()?.n, 0);
      assert.equal(native.prepare("SELECT count(*) n FROM file_publications").get()?.n, 0);
    } else {
      assert.equal(native.prepare("SELECT count(*) n FROM file_migration_jobs").get()?.n, 2);
      assert.equal(native.prepare("SELECT count(*) n FROM file_migration_jobs WHERE state='completed'").get()?.n, 2);
      assert.equal(native.prepare("SELECT count(*) n FROM file_migration_items WHERE state='moved'").get()?.n, 2);
      assert.equal(native.prepare("SELECT count(*) n FROM file_publications").get()?.n, 1);
    }
  } catch (error) { workFailed = true; workError = owner.workError = error; }
  try {
    if (owner.nativeAttempted && !owner.native) throw owner.nativeError;
    owner.close?.();
    assert.ok(owner.native && owner.closed && !owner.native.isOpen);
    retained.delete(owner);
  } catch (closeError) {
    if (workFailed) throw new AggregateError([workError, closeError], "Original read and first close failed");
    throw closeError;
  }
  if (workFailed) throw workError;
  process.stdout.write(JSON.stringify({ status: "PASS", phase: value.phase, globalIntegrity: true,
    foreignKeys: true, unreleasedSourceCount: 0, nativeFirstCloseAcknowledged: true,
    applicationOrPhysicalCloseClaimed: false }) + "\n");
}
main().catch(() => {
  process.stdout.write(JSON.stringify({ status: "FAIL", originalReaderClosureUnproven: retained.size !== 0 }) + "\n");
  process.exitCode = 1;
});
