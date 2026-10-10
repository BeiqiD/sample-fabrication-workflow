import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { checkedAcceptFileMigration } from "../../shared/contracts/file-jobs";
import { requireSystemAdministrator, canAdministerSystemSettings } from "../storage/system-administrator";
import type { Env } from "../types";
import { ensureFileAuthorityExecution } from "./authority-execution";
import { d1FileJobRepository } from "./jobs/d1-repository";
import { setFileJobExecution } from "./jobs/worker-runtime";

export const migrationRoutes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
migrationRoutes.use("/files/migrations", requireSystemAdministrator);
migrationRoutes.use("/files/migrations/*", requireSystemAdministrator);
async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "File migration input is required" });
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 32 * 1024) { await reader.cancel(); throw new HTTPException(413, { message: "File migration request is too large" }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HTTPException(400, { message: "Invalid File migration JSON" }); }
}
const parsed = async (request: Request) => {
  try { return checkedAcceptFileMigration(await boundedJson(request)); }
  catch (error) { if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: "Invalid bounded File migration selection" }); }
};
const cursor = (value: string | undefined) => {
  if (value !== undefined && (!value || value.length > 256 || /[\x00-\x20\x7f]/.test(value))) throw new HTTPException(400, { message: "Invalid File page cursor" });
  return value;
};
migrationRoutes.use("/files/migrations/*", async (c, next) => {
  const declared = c.req.header("content-length");
  if (declared && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 32 * 1024)) throw new HTTPException(413, { message: "File migration request is too large" });
  await next();
});
migrationRoutes.get("/files/migrations", async c => c.json({ jobs: await d1FileJobRepository(c.env.DB).list() }));
migrationRoutes.get("/files/migrations/files", async c => {
  const rawLimit = c.req.query("limit") ?? "100";
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) throw new HTTPException(400, { message: "File page limit must be 1 to 100" });
  return c.json(await d1FileJobRepository(c.env.DB).inventory({ profileId: cursor(c.req.query("profileId")),
    cursor: cursor(c.req.query("cursor")), limit: Number(rawLimit) }));
});
migrationRoutes.get("/files/migrations/executor", async c => c.json(await d1FileJobRepository(c.env.DB).executorStatus()));
migrationRoutes.post("/files/migrations/executor", async c => {
  const input = await boundedJson(c.req.raw) as { enabled?: unknown };
  if (!input || Object.keys(input).length !== 1 || typeof input.enabled !== "boolean") throw new HTTPException(400, { message: "Executor enabled must be a boolean" });
  return c.json(await setFileJobExecution(c.env, input.enabled));
});
migrationRoutes.post("/files/migrations/plans", async c => {
  const input = await parsed(c.req.raw);
  try { return c.json(await d1FileJobRepository(c.env.DB).plan(input)); }
  catch { throw new HTTPException(409, { message: "Selected Files or destination are unavailable" }); }
});
migrationRoutes.post("/files/migrations", async c => {
  await ensureFileAuthorityExecution(c.env.DB);
  const input = await parsed(c.req.raw);
  try { return c.json(await d1FileJobRepository(c.env.DB).accept(input, c.get("userEmail"),
    () => canAdministerSystemSettings(c.env, c.get("userEmail"))), 202); }
  catch { throw new HTTPException(409, { message: "File migration could not be accepted; refresh its plan or reuse the accepted input" }); }
});
migrationRoutes.get("/files/migrations/:jobId", async c => {
  const status = await d1FileJobRepository(c.env.DB).status(c.req.param("jobId"));
  if (!status) throw new HTTPException(404, { message: "File job does not exist" });
  return c.json(status);
});
migrationRoutes.get("/files/migrations/:jobId/items", async c => {
  const repository = d1FileJobRepository(c.env.DB);
  if (!await repository.status(c.req.param("jobId"))) throw new HTTPException(404, { message: "File job does not exist" });
  return c.json(await repository.items(c.req.param("jobId"), cursor(c.req.query("cursor"))));
});
migrationRoutes.post("/files/migrations/:jobId/cleanup", async c => {
  await ensureFileAuthorityExecution(c.env.DB);
  return c.json(await d1FileJobRepository(c.env.DB).requestCleanup(c.req.param("jobId"), c.get("userEmail"),
    () => canAdministerSystemSettings(c.env, c.get("userEmail"))), 202);
});
migrationRoutes.post("/files/migrations/:jobId/:action", async c => {
  await ensureFileAuthorityExecution(c.env.DB);
  const action = c.req.param("action");
  if (!["pause", "resume", "cancel", "retry"].includes(action)) throw new HTTPException(400, { message: "Unknown File job action" });
  return c.json(await d1FileJobRepository(c.env.DB).control(c.req.param("jobId"), action as "pause" | "resume" | "cancel" | "retry"));
});
