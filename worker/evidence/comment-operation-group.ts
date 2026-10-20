import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import { requireVisibleCommentOperationGroupWithDatabase } from "./comment-operation-group-service";
import { HTTPException } from "hono/http-exception";

export async function requireVisibleCommentOperationGroup(db: D1Database, operationGroupId: string) {
  return requireVisibleCommentOperationGroupWithDatabase(d1FileBusinessMetadataDatabase(db), operationGroupId);
}
