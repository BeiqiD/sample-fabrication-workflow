import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { readFileAuthorityMode } from "./authority-reader";

/** Restored canonical authority is not permission to run the source's jobs. */
export async function ensureFileAuthorityExecution(database: D1Database): Promise<void> {
  if (await readFileAuthorityMode(database) !== "active") return;
  const row = await primaryD1(database).prepare("SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1")
    .first<{ enabled: number }>();
  if (row?.enabled !== 1) {
    throw new HTTPException(503, { message: "File execution is paused on this installation. An operator must enable it after recovery." });
  }
}

export const fileAuthorityExecutionAdmission: MiddlewareHandler<{ Bindings: Env; Variables: { userEmail: string } }> = async (c, next) => {
  // File administration and read-only export use their own admission. Paused
  // recovery keeps authenticated reads and the explicit repair controls usable.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.path.startsWith("/api/files/")
    && !c.req.path.startsWith("/api/export/")) await ensureFileAuthorityExecution(c.env.DB);
  await next();
};
