import { d1SampleTimelineAttachmentDatabase } from "./timeline-attachment-d1";
import { removeSampleTimelineAttachmentWithDatabase } from "./timeline-attachment-service";
import { d1SampleFileMetadataDatabase } from "./file-metadata-d1";
import { splitSampleWithDatabase, createSampleRecordWithDatabase, removeSampleRecordWithDatabase, sampleHasFileBindingsWithDatabase } from "./file-metadata-service";
import { fileAuthorityActiveSql, deletedEventAssetSql, deletedVerificationAssetSql, deletedEventMetadataSql } from "../files/business-lifecycle";
import { consumerFileBindingFence, resolveConsumerFileId } from "../files/consumer-binding";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isSampleStatus, MAX_SPLIT_PIECES, type CreateRecordInput, type SampleStatus, type SplitSampleInput } from "../../shared/types";
import { isSampleRecordEvent } from "../../shared/sample-records";
import { prepareSplitInheritedState } from "../sample-split-state";
import { sampleMetadataHandlers } from "./metadata-worker";
import { sampleReadHandlers } from "./read-worker";
import type { Env } from "../types";
import { loadCurrentSampleStructure } from "../application/sample-structure";
import { requireVisibleCommentOperationGroup } from "../evidence/comment-operation-group";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

async function sampleHasFileBindings(db: D1Database): Promise<boolean> {
  return sampleHasFileBindingsWithDatabase(d1SampleFileMetadataDatabase(db));
}

routes.get("/sample-directory-options", sampleReadHandlers.captureIngressRequest, sampleReadHandlers.directoryOptions);

routes.get("/samples", sampleReadHandlers.captureIngressRequest, sampleReadHandlers.directory);

routes.post("/samples", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.create);

routes.post("/samples/:id/split", async (c) => {
  const parentId = c.req.param("id");
  const input = await c.req.json<SplitSampleInput>();
  return c.json(await splitSampleWithDatabase(d1SampleFileMetadataDatabase(c.env.DB), parentId, input, c.get("userEmail")), 201);
});

routes.get("/samples/:id", sampleReadHandlers.captureIngressRequest, sampleReadHandlers.detail);

routes.patch("/samples/:id", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.update);

routes.delete("/samples/:id", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.remove);

routes.post("/samples/:id/restore", sampleMetadataHandlers.captureIngressRequest, sampleMetadataHandlers.restore);

routes.post("/samples/:id/records", async (c) => {
  const sampleId = c.req.param("id");
  const input = await c.req.json<CreateRecordInput>();
  return c.json(await createSampleRecordWithDatabase(d1SampleFileMetadataDatabase(c.env.DB), sampleId, input, c.get("userEmail")), 201);
});

routes.delete("/samples/:id/records/:eventId", async (c) => {
  const sampleId = c.req.param("id");
  const eventId = c.req.param("eventId");
  return c.json(await removeSampleRecordWithDatabase(d1SampleFileMetadataDatabase(c.env.DB), sampleId, eventId, c.get("userEmail")));
});

routes.delete("/samples/:id/events/:eventId/asset", async (c) => {
  const sampleId = c.req.param("id");
  const eventId = c.req.param("eventId");
  return c.json(await removeSampleTimelineAttachmentWithDatabase(d1SampleTimelineAttachmentDatabase(c.env.DB), sampleId, eventId, c.get("userEmail")));
});
