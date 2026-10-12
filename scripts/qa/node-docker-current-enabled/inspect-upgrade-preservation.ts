// QA-only stopped, read-only inspector. No physical application-close claim.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { originalWitnessFilesClosed, verifyOriginalV25PreservedAtV26 } from "./upgrade-preservation";

interface Owner { attempted: boolean; native?: DatabaseSync; constructionError?: unknown;
  closeAttempted: boolean; acknowledged: boolean; closeError?: unknown }
const retained = new Set<Owner>();
function close(owner: Owner): void {
  if (owner.closeAttempted) { if (!owner.acknowledged) throw owner.closeError; return; }
  owner.closeAttempted = true;
  if (!originalWitnessFilesClosed()) { owner.closeError = new Error("Original witness file first close unproven"); throw owner.closeError; }
  if (owner.attempted && !owner.native) { owner.closeError = owner.constructionError; throw owner.closeError; }
  try { owner.native?.close(); assert.equal(owner.native?.isOpen, false); owner.acknowledged = true; retained.delete(owner); }
  catch (error) { owner.closeError = error; throw error; }
}
function main(): void {
  assert.equal(process.argv.length, 2); assert.equal(process.getuid?.(), 1000);
  const owner: Owner = { attempted: true, closeAttempted: false, acknowledged: false }; retained.add(owner);
  let failed = false, reason: unknown, tables = 0;
  try {
    try { owner.native = new DatabaseSync("/var/lib/sample/state/application.sqlite", {
      readOnly: true, allowExtension: false, enableForeignKeyConstraints: true }); }
    catch (error) { owner.constructionError = error; throw error; }
    tables = verifyOriginalV25PreservedAtV26(owner.native);
  } catch (error) { failed = true; reason = error; }
  try { close(owner); }
  catch (error) { if (failed) throw new AggregateError([reason, error], "Original inspection and native first close failed"); throw error; }
  if (failed) throw reason;
  assert.equal(retained.size, 0);
  process.stdout.write(JSON.stringify({ status: "PASS", checkpoint: "portable-runtime/v26", originalTables: tables,
    originalV25CellsAndLedgerPrefixPreserved: true, originalInstallationIdentityPreserved: true,
    noDomainWrites: true, privateWitnessFirstCloseAcknowledged: true, originalNativeFirstCloseAcknowledged: true,
    wholeApplicationPhysicalCloseClaimed: false }) + "\n");
}
try { main(); } catch {
  process.stdout.write(JSON.stringify({ status: "FAIL", originalReadOnlyOwnerRetained: retained.size !== 0,
    originalWitnessFileCloseUnproven: !originalWitnessFilesClosed() }) + "\n"); process.exitCode = 1;
}
