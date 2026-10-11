import { Hono } from "hono";
import type { CreateRunStepCommentsInput } from "../../shared/types";
import type { Env } from "../types";
import { createRunStepCommentsWithDatabase, removeRunStepCommentAssetWithDatabase, restoreRunStepCommentAssetWithDatabase, removeRunStepCommentWithDatabase, restoreRunStepCommentWithDatabase } from "./comment-metadata-service";
import { d1CommentMetadataDatabase } from "./comment-metadata-d1";

export const routes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();

routes.post("/run-step-comments", async (c) => {
  const input = await c.req.json<CreateRunStepCommentsInput>();
  return c.json(await createRunStepCommentsWithDatabase(d1CommentMetadataDatabase(c.env.DB), input, c.get("userEmail")), 201);
});

routes.delete("/run-step-comments/:id/asset", async (c) => {
  const commentId = c.req.param("id");
  return c.json(await removeRunStepCommentAssetWithDatabase(d1CommentMetadataDatabase(c.env.DB), commentId, c.get("userEmail")));
});

routes.post("/run-step-comments/:id/asset/restore", async (c) => {
  const commentId = c.req.param("id");
  return c.json(await restoreRunStepCommentAssetWithDatabase(d1CommentMetadataDatabase(c.env.DB), commentId, c.get("userEmail")));
});

routes.delete("/run-step-comments/:id", async (c) => {
  const commentId = c.req.param("id");
  return c.json(await removeRunStepCommentWithDatabase(d1CommentMetadataDatabase(c.env.DB), commentId, c.get("userEmail")));
});

routes.post("/run-step-comments/:id/restore", async (c) => {
  const commentId = c.req.param("id");
  return c.json(await restoreRunStepCommentWithDatabase(d1CommentMetadataDatabase(c.env.DB), commentId, c.get("userEmail")));
});
