import { runBlobGarbageCollection } from "./blob-lifecycle/gc";
import type { Env } from "./types";

export async function cleanupCommentUploads(env: Env, now = new Date()) {
  return runBlobGarbageCollection(env, now);
}
