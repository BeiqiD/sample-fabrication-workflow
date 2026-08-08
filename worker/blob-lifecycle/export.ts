import type {
  BlobExportOccurrence,
  FullExportBlobEntry,
} from "../../shared/types";

type Row = Record<string, unknown>;

interface MutableBlobEntry {
  storeKind: "r2" | "managed";
  provider: string;
  objectKey: string;
  blobRecordIds: Set<string>;
  filenames: Set<string>;
  expectedByteSize: number | null;
  expectedSha256: string | null;
  metadataReady: boolean;
  managedDownloadId: string | null;
  sourceOccurrences: BlobExportOccurrence[];
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function locatorId(storeKind: string, provider: string, objectKey: string) {
  return JSON.stringify([storeKind, provider, objectKey]);
}

function encodedR2Path(objectKey: string) {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

function fallbackFilename(objectKey: string) {
  return objectKey.split("/").filter(Boolean).at(-1) || "blob";
}

export function buildBlobExportPlan(tables: Record<string, Row[]>): FullExportBlobEntry[] {
  const entries = new Map<string, MutableBlobEntry>();
  const add = (input: {
    storeKind: "r2" | "managed";
    provider: string;
    objectKey: string;
    blobRecordId?: string | null;
    filename?: string | null;
    expectedByteSize?: number | null;
    expectedSha256?: string | null;
    metadataReady: boolean;
    managedDownloadId?: string | null;
  }) => {
    const id = locatorId(input.storeKind, input.provider, input.objectKey);
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        storeKind: input.storeKind,
        provider: input.provider,
        objectKey: input.objectKey,
        blobRecordIds: new Set(),
        filenames: new Set(),
        expectedByteSize: null,
        expectedSha256: null,
        metadataReady: false,
        managedDownloadId: null,
        sourceOccurrences: [],
      };
      entries.set(id, entry);
    }
    if (input.blobRecordId) entry.blobRecordIds.add(input.blobRecordId);
    if (input.filename) entry.filenames.add(input.filename);
    if (input.metadataReady) {
      entry.metadataReady = true;
      entry.expectedByteSize ??= input.expectedByteSize ?? null;
      entry.expectedSha256 ??= input.expectedSha256 ?? null;
      entry.managedDownloadId ??= input.managedDownloadId ?? null;
    }
  };

  for (const asset of tables.assets ?? []) {
    const objectKey = text(asset.r2_key);
    if (!objectKey) continue;
    add({
      storeKind: "r2",
      provider: "r2",
      objectKey,
      blobRecordId: text(asset.id),
      filename: text(asset.original_name),
      expectedByteSize: number(asset.byte_size),
      expectedSha256: text(asset.sha256),
      metadataReady: asset.status === "ready",
    });
  }

  for (const object of tables.managed_storage_objects ?? []) {
    const provider = text(object.provider);
    const objectKey = text(object.object_key);
    const id = text(object.id);
    if (!provider || !objectKey) continue;
    add({
      storeKind: "managed",
      provider,
      objectKey,
      blobRecordId: id,
      filename: text(object.original_name),
      expectedByteSize: number(object.byte_size),
      expectedSha256: text(object.sha256),
      metadataReady: object.status === "ready" || object.status === "orphaned",
      managedDownloadId: id,
    });
  }

  const addDirectR2 = (objectKey: unknown, filename?: unknown) => {
    const key = text(objectKey);
    if (!key) return;
    add({
      storeKind: "r2",
      provider: "r2",
      objectKey: key,
      filename: text(filename),
      metadataReady: true,
    });
  };
  for (const item of tables.imports ?? []) {
    addDirectR2(item.workbook_asset_key, item.source_filename);
    addDirectR2(item.manifest_asset_key, "manifest.json");
  }
  for (const template of tables.template_versions ?? []) {
    addDirectR2(template.source_asset_key, template.source_filename);
  }
  for (const event of tables.events ?? []) addDirectR2(event.asset_key);

  for (const edge of tables.blob_retention_edges ?? []) {
    const storeKind = edge.store_kind === "managed" ? "managed" : "r2";
    const provider = text(edge.provider);
    const objectKey = text(edge.object_key);
    if (!provider || !objectKey) continue;
    const id = locatorId(storeKind, provider, objectKey);
    const entry = entries.get(id);
    if (!entry) {
      add({ storeKind, provider, objectKey, metadataReady: false });
    }
    entries.get(id)?.sourceOccurrences.push({
      sourceType: text(edge.source_type) || "unknown",
      sourceId: text(edge.source_id) || "unknown",
      occurrenceType: text(edge.occurrence_type) || "unknown",
      occurrenceId: text(edge.occurrence_id) || "unknown",
      retentionReason: text(edge.retention_reason) || "unknown",
      retainUntil: text(edge.retain_until),
    });
  }

  const ledgerByLocator = new Map((tables.blob_gc_ledger ?? []).flatMap((row) => {
    const storeKind = text(row.store_kind);
    const provider = text(row.provider);
    const objectKey = text(row.object_key);
    return storeKind && provider && objectKey
      ? [[locatorId(storeKind, provider, objectKey), text(row.state)] as const]
      : [];
  }));

  return [...entries.entries()].map(([id, entry]): FullExportBlobEntry => {
    const ledgerState = ledgerByLocator.get(id);
    const deleted = ledgerState === "deleted";
    const downloadable = entry.metadataReady && !deleted
      && (entry.storeKind === "r2" || Boolean(entry.managedDownloadId));
    return {
      locatorId: id,
      storeKind: entry.storeKind,
      provider: entry.provider,
      objectKey: entry.objectKey,
      blobRecordIds: [...entry.blobRecordIds].sort(),
      filename: [...entry.filenames].sort()[0] || fallbackFilename(entry.objectKey),
      expectedByteSize: entry.expectedByteSize,
      expectedSha256: entry.expectedSha256,
      sourceOccurrences: entry.sourceOccurrences.sort((left, right) =>
        `${left.sourceType}:${left.sourceId}:${left.occurrenceType}:${left.occurrenceId}`
          .localeCompare(`${right.sourceType}:${right.sourceId}:${right.occurrenceType}:${right.occurrenceId}`)),
      downloadUrl: downloadable
        ? entry.storeKind === "r2"
          ? `/api/exports/r2/${encodedR2Path(entry.objectKey)}`
          : `/api/exports/managed/${encodeURIComponent(entry.managedDownloadId!)}`
        : null,
      initialOutcome: downloadable ? null : deleted ? "missing" : "metadata_not_ready",
    };
  }).sort((left, right) => left.locatorId.localeCompare(right.locatorId));
}
