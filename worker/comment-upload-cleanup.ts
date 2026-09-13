import { runApplicationMaintenance } from "./application/maintenance";
import type { Env } from "./types";

export async function cleanupCommentUploads(env: Env, now = new Date()) {
  return runApplicationMaintenance(env, now);
}
