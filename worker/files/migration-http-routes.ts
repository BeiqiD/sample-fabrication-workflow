import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { checkedAcceptFileMigration, type FileJobExecutorStatus } from "../../shared/contracts/file-jobs";
import type { FileJobRepository } from "./jobs/types";

export type FileMigrationHttpRepository = Pick<FileJobRepository,
  "list" | "inventory" | "executorStatus" | "plan" | "accept" | "status" | "items" | "requestCleanup" | "control">;
export type FileMigrationEnvironment<Bindings extends object> = {
  Bindings: Bindings; Variables: { userEmail: string };
};
/** The complete original ten metadata endpoints. Callers provide actual
 * installation/Request-owned authority and lifetime; this router issues no
 * grant, opens no provider and dispatches no background step. */
export function createFileMigrationRoutes<Bindings extends object>(options: {
  administrator: MiddlewareHandler<FileMigrationEnvironment<Bindings>>;
  repository(request: Request, bindings: Bindings, actor: string): FileMigrationHttpRepository;
  ensureFileExecution(request: Request, bindings: Bindings, actor: string): Promise<void>;
  setExecution(request: Request, bindings: Bindings, actor: string, enabled: boolean): Promise<FileJobExecutorStatus>;
  canAdminister(request: Request, bindings: Bindings, actor: string): boolean;
}) {
const migrationRoutes = new Hono<FileMigrationEnvironment<Bindings>>();
migrationRoutes.use("/files/migrations", options.administrator);
migrationRoutes.use("/files/migrations/*", options.administrator);
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
migrationRoutes.get("/files/migrations", async c => c.json({ jobs: await options.repository(c.req.raw, c.env, c.get("userEmail")).list() }));
migrationRoutes.get("/files/migrations/files", async c => {
  const rawLimit = c.req.query("limit") ?? "100";
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(rawLimit)) throw new HTTPException(400, { message: "File page limit must be 1 to 100" });
  return c.json(await options.repository(c.req.raw, c.env, c.get("userEmail")).inventory({ profileId: cursor(c.req.query("profileId")),
    cursor: cursor(c.req.query("cursor")), limit: Number(rawLimit) }));
});
migrationRoutes.get("/files/migrations/executor", async c => c.json(await options.repository(c.req.raw, c.env, c.get("userEmail")).executorStatus()));
migrationRoutes.post("/files/migrations/executor", async c => {
  const input = await boundedJson(c.req.raw) as { enabled?: unknown };
  if (!input || Object.keys(input).length !== 1 || typeof input.enabled !== "boolean") throw new HTTPException(400, { message: "Executor enabled must be a boolean" });
  return c.json(await options.setExecution(c.req.raw, c.env, c.get("userEmail"), input.enabled));
});
migrationRoutes.post("/files/migrations/plans", async c => {
  const input = await parsed(c.req.raw);
  try { return c.json(await options.repository(c.req.raw, c.env, c.get("userEmail")).plan(input)); }
  catch { throw new HTTPException(409, { message: "Selected Files or destination are unavailable" }); }
});
migrationRoutes.post("/files/migrations", async c => {
  await options.ensureFileExecution(c.req.raw, c.env, c.get("userEmail"));
  const input = await parsed(c.req.raw);
  try { return c.json(await options.repository(c.req.raw, c.env, c.get("userEmail")).accept(input, c.get("userEmail"),
    () => options.canAdminister(c.req.raw, c.env, c.get("userEmail"))), 202); }
  catch { throw new HTTPException(409, { message: "File migration could not be accepted; refresh its plan or reuse the accepted input" }); }
});
migrationRoutes.get("/files/migrations/:jobId", async c => {
  const status = await options.repository(c.req.raw, c.env, c.get("userEmail")).status(c.req.param("jobId"));
  if (!status) throw new HTTPException(404, { message: "File job does not exist" });
  return c.json(status);
});
migrationRoutes.get("/files/migrations/:jobId/items", async c => {
  const repository = options.repository(c.req.raw, c.env, c.get("userEmail"));
  if (!await repository.status(c.req.param("jobId"))) throw new HTTPException(404, { message: "File job does not exist" });
  return c.json(await repository.items(c.req.param("jobId"), cursor(c.req.query("cursor"))));
});
migrationRoutes.post("/files/migrations/:jobId/cleanup", async c => {
  await options.ensureFileExecution(c.req.raw, c.env, c.get("userEmail"));
  return c.json(await options.repository(c.req.raw, c.env, c.get("userEmail")).requestCleanup(c.req.param("jobId"), c.get("userEmail"),
    () => options.canAdminister(c.req.raw, c.env, c.get("userEmail"))), 202);
});
migrationRoutes.post("/files/migrations/:jobId/:action", async c => {
  await options.ensureFileExecution(c.req.raw, c.env, c.get("userEmail"));
  const action = c.req.param("action");
  if (!["pause", "resume", "cancel", "retry"].includes(action)) throw new HTTPException(400, { message: "Unknown File job action" });
  return c.json(await options.repository(c.req.raw, c.env, c.get("userEmail")).control(c.req.param("jobId"), action as "pause" | "resume" | "cancel" | "retry"));
});
  return migrationRoutes;
}
