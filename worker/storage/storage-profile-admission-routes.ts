import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { checkedStorageCandidateReadinessInput } from "../../shared/contracts/storage-candidate-readiness";
import { checkedStorageProfileAdmissionInput, checkedStorageProfileAdmissionOperationId, checkedStorageProfileAdmissionReceipt,
  MAX_STORAGE_PROFILE_ADMISSION_INPUT_BYTES } from "../../shared/contracts/storage-profile-admission";
import type { Env } from "../types";
import { findStorageProfileAdmission, readStorageProfileAdmission, registerStorageProfile, StorageProfileAdmissionError } from "./storage-profile-admission-service";
import { requireSystemAdministrator } from "./system-administrator";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageProfileAdmissionRoutes = new Hono<Bindings>();
const unavailable = "Storage profile registration is temporarily unavailable.";
function failure(error: unknown): { error: string; status: 400 | 404 | 409 | 503 } {
  return error instanceof StorageProfileAdmissionError && error.status !== 503 ? { error: error.message, status: error.status }
    : { error: unavailable, status: 503 };
}
storageProfileAdmissionRoutes.get("/storage/configuration/registrations", requireSystemAdministrator, async c => {
  let input;
  try {
    const query = new URL(c.req.url).searchParams, revision = query.get("expectedRevision");
    if (query.size !== 2 || query.getAll("profileId").length !== 1 || query.getAll("expectedRevision").length !== 1
      || revision === null || !/^[1-9][0-9]*$/.test(revision)) throw new Error();
    input = checkedStorageCandidateReadinessInput({ profileId: query.get("profileId"), expectedRevision: Number(revision) });
  } catch { return c.json({ error: "Invalid storage profile registration." }, 400); }
  try { return c.json(checkedStorageProfileAdmissionReceipt(await findStorageProfileAdmission(c.env, input, c.get("userEmail")))); }
  catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});
storageProfileAdmissionRoutes.get("/storage/configuration/registrations/:operationId", requireSystemAdministrator, async c => {
  let operationId;
  try {
    if (new URL(c.req.url).searchParams.size) throw new Error();
    operationId = checkedStorageProfileAdmissionOperationId(c.req.param("operationId"));
  } catch { return c.json({ error: "Invalid storage profile registration." }, 400); }
  try { return c.json(checkedStorageProfileAdmissionReceipt(await readStorageProfileAdmission(c.env, operationId, c.get("userEmail")))); }
  catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});
storageProfileAdmissionRoutes.post("/storage/configuration/registrations", requireSystemAdministrator,
  bodyLimit({ maxSize: MAX_STORAGE_PROFILE_ADMISSION_INPUT_BYTES, onError: c => c.json({ error: "Storage profile registration is too large." }, 413) }), async c => {
    let input;
    try {
      if (new URL(c.req.url).searchParams.size || c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error();
      input = checkedStorageProfileAdmissionInput(await c.req.json());
    } catch { return c.json({ error: "Invalid storage profile registration." }, 400); }
    try { return c.json(checkedStorageProfileAdmissionReceipt(await registerStorageProfile(c.env, input, c.get("userEmail")))); }
    catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
  });
