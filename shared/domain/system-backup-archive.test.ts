import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemBackupArchiveStream, measureSystemBackupArchive, renderSystemBackupReport, systemBackupArchiveMetadata, type SystemBackupReportProjection } from "./system-backup-archive";
import { sourceFromBlob, validateStoreArchive, type ArchiveHashFactory } from "./research-archive";
const bytes = Uint8Array.of(1, 3, 5, 7), sha = createHash("sha256").update(bytes).digest("hex");
const createHashSink: ArchiveHashFactory = () => { const hash = createHash("sha256"); return { write(chunk) { hash.update(chunk); }, finish() { return hash.digest("hex"); } }; };
function fixture(): SystemBackupReportProjection {
  return { backupId: "backup", createdAt: "2026-10-06T12:00:00.000Z", sourceSnapshotClock: "2026-10-06 12:00:00", completeness: "partial",
    counts: { tables: 96, rows: 125, sources: 2, packagedFiles: 1, unavailableFiles: 1, bytes: 4 },
    protectedConfiguration: { keyIds: ["root-key"], rootKeysIncluded: false, automaticExecution: false },
    files: [{ id: "b_0000", path: "files/b_0000", outcome: "packaged", byteSize: 4, sha256: sha, fileIds: ["original"], purposes: ["research_source"],
      source: { filename: "<script>alert(1)</script>.csv", sourceOccurrences: [] }, bindings: [{ consumerKind: "template_version", consumerId: "revision", consumerSubId: "", fileSlot: "source" }] },
    { id: "b_0001", path: null, outcome: "missing", byteSize: null, sha256: null, fileIds: ["missing-file"], purposes: ["embedded_content"], source: { filename: "lost.png", sourceOccurrences: [] }, bindings: [] }] };
}
async function collect(stream: ReadableStream<Uint8Array>) { const reader = stream.getReader(), chunks: Uint8Array[] = []; let length = 0; try { while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); length += next.value.length; } } finally { reader.releaseLock(); } const output = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output; }
describe("shared bounded system backup archive and inert completeness report", () => {
  it("shows unavailable affected Files and disabled recovery instead of a success-only download", () => {
    const report = renderSystemBackupReport(fixture());
    expect(report.html).toContain("This backup is partial"); expect(report.html).toContain("complete activation is blocked");
    expect(report.html).toContain("missing-file"); expect(report.html).toContain("&lt;script&gt;"); expect(report.html).not.toContain("<script>");
    expect(report.html).toContain("script-src 'none'"); expect(report.html).toContain('href="../files/b_0000"');
    expect(report.markdown).toContain("1/2 packaged files");
  });
  it("uses the existing deterministic four-member ZIP and includes only verified payloads", async () => {
    const report = fixture(), metadata = await systemBackupArchiveMetadata({ schema: "system-backup/1" }, { schema: "system-backup-records/1" }, report);
    expect([...metadata.contents.keys()]).toEqual(["manifest.json", "records.json", "report/index.html", "report/report.md"]);
    const open = async () => new Blob([bytes]).stream();
    const measured = await measureSystemBackupArchive(metadata, open, { createHash: createHashSink });
    const output = await collect(createSystemBackupArchiveStream(metadata, open, { createHash: createHashSink }));
    expect(measured.byteSize).toBe(output.length); expect(measured.sha256).toBe(createHash("sha256").update(output).digest("hex"));
    const admitted = await validateStoreArchive(sourceFromBlob(new Blob([output])), { expectedSha256: measured.sha256, expectedEntries: metadata.entries, createHash: createHashSink });
    expect(admitted.entries).toHaveLength(5); expect(admitted.entries.some(entry => entry.path === "files/b_0001")).toBe(false);
    const repeated = await collect(createSystemBackupArchiveStream(metadata, open)); expect(repeated).toEqual(output);
  });
  it("rejects metadata budget overflow before opening any source bytes", async () => {
    await expect(systemBackupArchiveMetadata({}, { oversized: "x".repeat(4 * 1024 * 1024) }, fixture())).rejects.toThrow("system_backup_metadata_budget");
  });
});
