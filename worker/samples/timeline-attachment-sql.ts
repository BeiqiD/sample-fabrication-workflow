import type { SampleFileMetadataDatabase, SampleFileMetadataStatement } from "./file-metadata-sql";

/** Trusted, original code-owned metadata queries only. A future native adapter
 * must preserve actual RETURNING rows separately from trigger-sensitive changes,
 * validate exact business scalars and use genuine same-BEGIN current Request,
 * installation and every affected resource/operation guard. This structural
 * shape conveys no capability, provider access or library permission. */
export interface SampleTimelineAttachmentDatabase<Statement extends SampleFileMetadataStatement<Statement>> extends SampleFileMetadataDatabase<Statement> {
  atomicBatch(items: Statement[]): Promise<{
    results: Record<string, unknown>[];
    meta: { changes: number | bigint };
  }[]>;
}
