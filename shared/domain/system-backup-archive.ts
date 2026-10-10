import { stableJson, sha256Hex } from "./content-addressing";
import { createStoreArchiveStream, measureStoreArchive, type ArchiveEntry, type ArchiveOptions, type OpenArchiveEntry } from "./research-archive";

/** Domain-owned presentation projection; the contracts layer validates the
 * installation records and file outcomes before supplying this projection. */
export interface SystemBackupReportProjection {
  backupId: string; createdAt: string; sourceSnapshotClock: string; completeness: "complete" | "partial";
  counts: { tables: number; rows: number; sources: number; packagedFiles: number; unavailableFiles: number; bytes: number };
  protectedConfiguration: { keyIds: readonly string[]; rootKeysIncluded: false; automaticExecution: false };
  relocatedSources?: readonly { evidenceId: string; sourceLocatorId: string; destinationLocationId: string; byteSize: number; sha256: string }[];
  files: readonly { id: string; path: string | null; outcome: string; byteSize: number | null; sha256: string | null;
    fileIds: readonly string[]; purposes: readonly string[]; source: { filename: string; sourceOccurrences: readonly { sourceType: string; sourceId: string; occurrenceType: string; occurrenceId: string }[] };
    bindings: readonly { consumerKind: string; consumerId: string; consumerSubId: string; fileSlot: string }[] }[];
}
function html(value: unknown) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function markdown(value: unknown) { return String(value).replace(/[\\`*_{}\[\]<>#|]/g, "\\$&").replace(/[\r\n]/g, " "); }
export function renderSystemBackupReport(backup: SystemBackupReportProjection): { html: string; markdown: string } {
  const state = backup.completeness === "complete" ? "All promised bytes are packaged and verified." : "This backup is partial. Required bytes are unavailable; complete activation is blocked.";
  const summary = `${backup.counts.tables} tables, ${backup.counts.rows} rows, ${backup.counts.packagedFiles}/${backup.counts.sources} packaged files, ${backup.counts.bytes} bytes.`;
  const rows = backup.files.map(file => {
    const name = html(file.source.filename), link = file.path ? `<a href="../${html(file.path)}" download>${name}</a>` : name;
    const affected = [...file.bindings.map(binding => `${binding.consumerKind}:${binding.consumerId}:${binding.consumerSubId}:${binding.fileSlot}`), ...file.fileIds.map(id => `File:${id}`),
      ...file.source.sourceOccurrences.map(occurrence => `${occurrence.sourceType}:${occurrence.sourceId}:${occurrence.occurrenceType}:${occurrence.occurrenceId}`)];
    return `<tr><td>${link}</td><td>${html(file.outcome)}</td><td>${file.byteSize ?? "unavailable"}</td><td>${html(file.purposes.join(", "))}</td><td>${html(affected.join("; "))}</td></tr>`;
  }).join("");
  const relocated = backup.relocatedSources ?? [];
  const relocationHtml = relocated.length ? `<h2>Verified recovery relocations</h2><p>Old physical addresses remain historical evidence. Required bytes are preserved at these verified recovered locations.</p><ul>${relocated.map(entry => `<li>${html(entry.sourceLocatorId)} → ${html(entry.destinationLocationId)}; proof ${html(entry.evidenceId)}; ${entry.byteSize} bytes; SHA-256 ${html(entry.sha256)}</li>`).join("")}</ul>` : "";
  const markup = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>System backup ${html(backup.backupId)}</title><style>body{font:16px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border:1px solid #ccc;padding:.5rem;overflow-wrap:anywhere}.partial{font-weight:bold;color:#9d3400}</style></head><body><h1>System backup</h1><p>Backup ${html(backup.backupId)} — ${html(backup.createdAt)}</p><p>Source snapshot ${html(backup.sourceSnapshotClock)}</p><p class="${backup.completeness}">${html(state)}</p><p>${html(summary)}</p><p>Canonical identities, relationships, history and recoverable deletion states are preserved. Connection credentials remain encrypted. Root encryption keys are recovered separately. Restored jobs, provider probes and cleanup remain disabled until destination review.</p><table><thead><tr><th>File</th><th>Outcome</th><th>Bytes</th><th>Purposes</th><th>Affected records</th></tr></thead><tbody>${rows}</tbody></table>${relocationHtml}</body></html>`;
  const lines = ["# System backup", "", `Backup: ${markdown(backup.backupId)}`, `Created: ${markdown(backup.createdAt)}`, `Source snapshot: ${markdown(backup.sourceSnapshotClock)}`, "", state, "", summary, "",
    "Canonical identities, relationships, history and recoverable deletion states are preserved. Credentials remain encrypted; root encryption keys are recovered separately. Restored execution remains disabled until destination review.", "", "| File | Outcome | Bytes | Purposes | Affected records |", "| --- | --- | --- | --- | --- |"];
  for (const file of backup.files) {
    const name = markdown(file.source.filename), link = file.path ? `[${name}](../${file.path})` : name;
    const affected = [...file.bindings.map(binding => `${binding.consumerKind}:${binding.consumerId}:${binding.consumerSubId}:${binding.fileSlot}`), ...file.fileIds.map(id => `File:${id}`),
      ...file.source.sourceOccurrences.map(occurrence => `${occurrence.sourceType}:${occurrence.sourceId}:${occurrence.occurrenceType}:${occurrence.occurrenceId}`)];
    lines.push(`| ${link} | ${markdown(file.outcome)} | ${file.byteSize ?? "unavailable"} | ${markdown(file.purposes.join(", "))} | ${markdown(affected.join("; "))} |`);
  }
  if (relocated.length) {
    lines.push("", "## Verified recovery relocations", "", "Old physical addresses remain historical evidence; required bytes are preserved at verified recovered locations.");
    for (const entry of relocated) lines.push(`- ${markdown(entry.sourceLocatorId)} → ${markdown(entry.destinationLocationId)}; proof ${markdown(entry.evidenceId)}; ${entry.byteSize} bytes; SHA-256 ${entry.sha256}`);
  }
  return { html: markup, markdown: `${lines.join("\n")}\n` };
}

export interface SystemBackupArchiveMetadata { contents: ReadonlyMap<string, string>; entries: ArchiveEntry[] }
export async function systemBackupArchiveMetadata(manifest: unknown, records: unknown, report: SystemBackupReportProjection): Promise<SystemBackupArchiveMetadata> {
  const readable = renderSystemBackupReport(report);
  const contents = new Map<string, string>([["manifest.json", stableJson(manifest)], ["records.json", stableJson(records)],
    ["report/index.html", readable.html], ["report/report.md", readable.markdown]]);
  const entries: ArchiveEntry[] = []; let metadataBytes = 0;
  for (const [path, content] of contents) {
    const byteSize = new TextEncoder().encode(content).byteLength; metadataBytes += byteSize;
    entries.push({ path, kind: path.startsWith("report/") ? "report" : "metadata", byteSize, sha256: await sha256Hex(content) });
  }
  if (metadataBytes > 4 * 1024 * 1024) throw new Error("system_backup_metadata_budget");
  for (const file of report.files) if (file.outcome === "packaged") {
    if (!file.path || file.byteSize === null || file.sha256 === null) throw new Error("system_backup_payload_inventory");
    entries.push({ path: file.path, kind: "payload", byteSize: file.byteSize, sha256: file.sha256 });
  }
  return { contents, entries };
}
export function openSystemBackupArchiveMetadata(metadata: SystemBackupArchiveMetadata, openPayload: OpenArchiveEntry): OpenArchiveEntry {
  return async (entry, signal) => {
    if (signal?.aborted) throw signal.reason;
    const content = metadata.contents.get(entry.path);
    if (content === undefined) return openPayload(entry, signal);
    const bytes = new TextEncoder().encode(content);
    return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  };
}
export function measureSystemBackupArchive(metadata: SystemBackupArchiveMetadata, openPayload: OpenArchiveEntry, options: ArchiveOptions = {}) {
  return measureStoreArchive(metadata.entries, openSystemBackupArchiveMetadata(metadata, openPayload), options);
}
export function createSystemBackupArchiveStream(metadata: SystemBackupArchiveMetadata, openPayload: OpenArchiveEntry, options: ArchiveOptions = {}) {
  return createStoreArchiveStream(metadata.entries, openSystemBackupArchiveMetadata(metadata, openPayload), options);
}
