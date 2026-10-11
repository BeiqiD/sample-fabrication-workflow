import { executeOfflineV28Restore, parseOfflineV28RestoreCommand, OfflineV28RestoreError } from "./restore-v28-operator";

const USAGE = "Usage: offline-v28 restore --archive <canonical-private-v5-zip> --destination <new-private-directory> --sha256 <archive-sha256> [--filesystem-root-owner-uid UID]\nFixed V5 complete archive to an inert V28 destination only. Existing destinations are refused. No startup, migration of an existing installation, administrator, File profile binding or Group grant is activated.\n";
async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === "--help") { process.stdout.write(USAGE); return; }
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const command = parseOfflineV28RestoreCommand(process.argv.slice(2));
    const original = executeOfflineV28Restore(command);
    const result = await original; // Original restore/native/archive ACK, never a diagnostic timeout.
    if (interrupted) throw new OfflineV28RestoreError();
    process.stdout.write(JSON.stringify({ kind: "offline-v28-inert-restore/1", archiveFormat: "v5",
      sourceArchiveSha256: result.report.sourceArchiveSha256,
      destinationInstallationId: result.report.destinationInstallationId,
      destinationCheckpoint: result.report.destinationCheckpoint,
      rows: result.report.rows, payloads: result.report.payloads, executionEnabled: false }) + "\n");
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
void main().catch(() => {
  // Neither private paths nor archive/account/credential cells are diagnostics.
  process.stderr.write("Offline V28 restoration unavailable.\n"); process.exitCode = 1;
});
