import { d1SampleFileMetadataDatabase } from "./file-metadata-d1";
import type { SampleTimelineAttachmentDatabase } from "./timeline-attachment-sql";

/** Genuine existing Worker binding. Retain every original D1 batch result and
 * RETURNING row without replacing it with total changes or a synthetic Env. */
export function d1SampleTimelineAttachmentDatabase(database: D1Database): SampleTimelineAttachmentDatabase<D1PreparedStatement> {
  return {
    ...d1SampleFileMetadataDatabase(database),
    atomicBatch(items) { return database.batch(items); },
  };
}
