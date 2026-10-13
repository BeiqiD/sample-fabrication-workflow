// QA-only fixed historical checkpoint witness. No product selector or DDL input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { CURRENT_NODE_INSTALLATION_CATALOG as V25 } from "../../../server/installation-catalog";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG as V26 } from "../../../server/operational-installation-catalog";
import { admitInstallationRecoverySource, assertInstallationAdmission } from "../../../server/migrations";

const proofPath = "/var/lib/sample/state/.qa-original-v25-preservation.json";
const maxProofBytes = 131_072;
type TableWitness = Readonly<{ name: string; columns: readonly string[]; rows: number; sha256: string }>;
type Witness = Readonly<{ version: 1; installation: Readonly<{ installationId: string; catalogId: string; createdAt: string }>;
  ledger: readonly unknown[]; tables: readonly TableWitness[] }>;
interface FileOwner { fd?: number; openingError?: unknown; attempted: boolean; acknowledged: boolean; error?: unknown }
const retainedFiles = new Set<FileOwner>();

function openWitnessFile(flags: number): FileOwner {
  const owner: FileOwner = { attempted: false, acknowledged: false }; retainedFiles.add(owner);
  try { owner.fd = openSync(proofPath, flags, 0o600); return owner; }
  catch (error) { owner.openingError = error; throw error; }
}

function originalFileClose(owner: FileOwner): void {
  if (owner.attempted) { if (!owner.acknowledged) throw owner.error; return; }
  owner.attempted = true;
  if (owner.fd === undefined) { owner.error = owner.openingError; throw owner.error; }
  try { closeSync(owner.fd); owner.acknowledged = true; retainedFiles.delete(owner); }
  catch (error) { owner.error = error; throw error; }
}
function quoted(name: string): string {
  assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  return '"' + name + '"';
}
function exactCell(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "number") { assert.ok(Number.isFinite(value)); return ["real", value]; }
  assert.ok(value instanceof Uint8Array); return ["blob", Buffer.from(value).toString("base64")];
}
function tableWitness(native: DatabaseSync, name: string, originalColumns?: readonly string[]): TableWitness {
  const actualColumns = native.prepare("PRAGMA table_info(" + quoted(name) + ")").all().map(row => row.name);
  assert.ok(actualColumns.length > 0 && actualColumns.every(name => typeof name === "string"));
  const columns = originalColumns ?? actualColumns as string[];
  assert.ok(columns.length > 0 && columns.length < 128 && columns.every(name => actualColumns.includes(name)));
  const statement = native.prepare("SELECT " + columns.map(quoted).join(",") + " FROM " + quoted(name)); statement.setReadBigInts(true);
  const rows = statement.all().map(row => JSON.stringify(Object.keys(row).sort().map(key => [key, exactCell(row[key])]))).sort();
  return Object.freeze({ name, columns: Object.freeze([...columns]), rows: rows.length,
    sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") });
}
function originalLedger(native: DatabaseSync): readonly unknown[] {
  const statement = native.prepare("SELECT * FROM node_migrations ORDER BY ordinal"); statement.setReadBigInts(true);
  return statement.all().map(row => Object.keys(row).sort().map(key => [key, exactCell(row[key])]));
}
function witness(native: DatabaseSync, expected: "v25" | "v26", originalTables?: readonly TableWitness[]): Witness {
  const catalog = expected === "v25" ? V25 : V26;
  const admission = assertInstallationAdmission(native, admitInstallationRecoverySource(native, catalog));
  assert.equal(admission.checkpointId, "portable-runtime/" + expected);
  const checkpoint = V25.migrations.at(-1)?.checkpoint; assert.ok(checkpoint);
  const names = [...new Set(checkpoint.applicationObjects.filter(object => object.type === "table").map(object => object.name))].sort();
  assert.ok(names.length > 100 && names.length < 256);
  const healthy = native.prepare("PRAGMA integrity_check").all();
  assert.equal(healthy.length, 1); assert.equal(Object.values(healthy[0]!)[0], "ok");
  assert.deepEqual(native.prepare("PRAGMA foreign_key_check").all(), []);
  return Object.freeze({ version: 1, installation: Object.freeze({ installationId: admission.installationId,
    catalogId: admission.catalogId, createdAt: admission.createdAt }), ledger: originalLedger(native),
    tables: Object.freeze(names.map(name => tableWitness(native, name, originalTables?.find(table => table.name === name)?.columns))) });
}
export function retainOriginalV25Witness(native: DatabaseSync): number {
  const before = witness(native, "v25");
  assert.ok(before.tables.some(table => table.name === "samples" && table.rows > 0));
  assert.ok(before.tables.some(table => table.name === "projects" && table.rows > 0));
  const bytes = Buffer.from(JSON.stringify(before) + "\n"); assert.ok(bytes.length > 0 && bytes.length <= maxProofBytes);
  const owner = openWitnessFile(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
  assert.ok(owner.fd !== undefined);
  let failed = false, reason: unknown;
  try {
    const stat = fstatSync(owner.fd); assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === 1000 && (stat.mode & 0o7777) === 0o600);
    let written = 0; while (written < bytes.length) { const count = writeSync(owner.fd, bytes, written, bytes.length - written); assert.ok(count > 0); written += count; }
    const after = fstatSync(owner.fd), path = lstatSync(proofPath);
    assert.equal(after.size, bytes.length); assert.ok(!path.isSymbolicLink() && path.isFile());
    assert.equal(path.dev, after.dev); assert.equal(path.ino, after.ino);
  } catch (error) { failed = true; reason = error; }
  try { originalFileClose(owner); } catch (error) { if (failed) throw new AggregateError([reason, error], "Original witness work and first file close failed"); throw error; }
  finally { bytes.fill(0); }
  if (failed) throw reason;
  return before.tables.length;
}
export function verifyOriginalV25PreservedAtV26(native: DatabaseSync): number {
  const owner = openWitnessFile(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  assert.ok(owner.fd !== undefined);
  let failed = false, reason: unknown, before: Witness | undefined;
  const bytes = Buffer.alloc(maxProofBytes + 1);
  try {
    const stat = fstatSync(owner.fd); assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === 1000 && (stat.mode & 0o7777) === 0o600);
    assert.ok(stat.size > 0 && stat.size <= maxProofBytes);
    let length = 0; while (length < bytes.length) { const count = readSync(owner.fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
    assert.equal(length, stat.size);
    const afterStat = fstatSync(owner.fd), path = lstatSync(proofPath);
    assert.equal(afterStat.size, stat.size); assert.equal(afterStat.mtimeMs, stat.mtimeMs); assert.equal(afterStat.ctimeMs, stat.ctimeMs);
    assert.ok(!path.isSymbolicLink() && path.isFile()); assert.equal(path.dev, afterStat.dev); assert.equal(path.ino, afterStat.ino);
    before = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as Witness;
    assert.equal(before.version, 1); assert.equal(before.ledger.length, V25.migrations.length);
    const after = witness(native, "v26", before.tables);
    assert.deepEqual(after.installation, before.installation);
    assert.equal(after.ledger.length, V26.migrations.length);
    assert.equal(after.ledger.length, before.ledger.length + 1);
    assert.deepEqual(after.ledger.slice(0, before.ledger.length), before.ledger);
    assert.deepEqual(after.tables, before.tables); // Every original application cell, including identity and history.
  } catch (error) { failed = true; reason = error; }
  try { originalFileClose(owner); } catch (error) { if (failed) throw new AggregateError([reason, error], "Original witness read and first file close failed"); throw error; }
  finally { bytes.fill(0); }
  if (failed) throw reason;
  assert.ok(before); return before.tables.length;
}
export function originalWitnessFilesClosed(): boolean { return retainedFiles.size === 0; }
