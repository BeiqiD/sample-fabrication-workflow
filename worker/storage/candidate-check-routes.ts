import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MAX_STORAGE_CHECK_INPUT_BYTES, checkedStartStorageCandidateCheckInput,
  checkedStorageCandidateCheckCleanupInput, checkedStorageCandidateCheckId,
  checkedStorageCandidateCheckProfileId, StorageCandidateCheckInputError,
} from "../../shared/contracts/storage-candidate-check";
import type { Env } from "../types";
import {
  cleanupStorageCandidateCheck, listStorageCandidateChecks, readStorageCandidateCheck,
  startStorageCandidateCheck, StorageCandidateCheckError,
} from "./candidate-check-service";
import { requireSystemAdministrator } from "./system-administrator";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageCandidateCheckRoutes = new Hono<Bindings>();
const limit = bodyLimit({ maxSize: MAX_STORAGE_CHECK_INPUT_BYTES,
  onError: c => c.json({ error: "Storage candidate check is too large." }, 413) });
function jsonContentType(value: string | undefined) { return value?.split(";")[0].trim().toLowerCase() === "application/json"; }
function failure(error: unknown): { error: string; status: 400 | 404 | 409 | 503 } {
  if (error instanceof StorageCandidateCheckInputError) return { error: error.message, status: 400 };
  if (error instanceof StorageCandidateCheckError) return { error: error.message, status: error.status };
  return { error: "Storage candidate check is temporarily unavailable.", status: 503 };
}

storageCandidateCheckRoutes.post("/storage/configuration/checks", requireSystemAdministrator, limit, async c => {
  if (!jsonContentType(c.req.header("content-type"))) return c.json({ error: "Invalid storage candidate check." }, 400);
  let input;
  try { input = checkedStartStorageCandidateCheckInput(await c.req.json()); }
  catch { return c.json({ error: "Invalid storage candidate check." }, 400); }
  try { return c.json(await startStorageCandidateCheck(c.env, input, c.get("userEmail"))); }
  catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});

storageCandidateCheckRoutes.get("/storage/configuration/checks", requireSystemAdministrator, async c => {
  try {
    const query = new URL(c.req.url).searchParams;
    if (query.size !== 1 || query.getAll("profileId").length !== 1) throw new StorageCandidateCheckInputError();
    const profileId = checkedStorageCandidateCheckProfileId(query.get("profileId"));
    return c.json(await listStorageCandidateChecks(c.env, profileId, c.get("userEmail")));
  } catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});

storageCandidateCheckRoutes.get("/storage/configuration/checks/:checkId", requireSystemAdministrator, async c => {
  try {
    const checkId = checkedStorageCandidateCheckId(c.req.param("checkId"));
    return c.json(await readStorageCandidateCheck(c.env, checkId, c.get("userEmail")));
  } catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});

storageCandidateCheckRoutes.post("/storage/configuration/checks/:checkId/cleanup", requireSystemAdministrator, limit, async c => {
  if (!jsonContentType(c.req.header("content-type"))) return c.json({ error: "Invalid storage candidate check." }, 400);
  let checkId;
  try {
    checkId = checkedStorageCandidateCheckId(c.req.param("checkId"));
    checkedStorageCandidateCheckCleanupInput(await c.req.json());
  } catch { return c.json({ error: "Invalid storage candidate check." }, 400); }
  try { return c.json(await cleanupStorageCandidateCheck(c.env, checkId, c.get("userEmail"))); }
  catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});
