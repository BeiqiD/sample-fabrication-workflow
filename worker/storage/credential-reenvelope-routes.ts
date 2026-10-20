import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MAX_STORAGE_CREDENTIAL_REENVELOPE_INPUT_BYTES, checkedReenvelopeStorageCredentialInput,
  checkedStorageCredentialEnvelopeProfileId, checkedStorageCredentialReenvelopeOperationId,
  StorageCredentialReenvelopeInputError,
} from "../../shared/contracts/storage-credential-reenvelope";
import type { Env } from "../types";
import {
  listStorageCredentialEnvelopes, readStorageCredentialReenvelope, reenvelopeStoredStorageCredential,
  StorageCredentialReenvelopeError,
} from "./credential-reenvelope-service";
import { requireSystemAdministrator } from "./system-administrator";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageCredentialReenvelopeRoutes = new Hono<Bindings>();
const limit = bodyLimit({ maxSize: MAX_STORAGE_CREDENTIAL_REENVELOPE_INPUT_BYTES,
  onError: c => c.json({ error: "Storage credential re-envelope is too large." }, 413) });
function jsonContentType(value: string | undefined) { return value?.split(";")[0].trim().toLowerCase() === "application/json"; }
function failure(error: unknown): { error: string; status: 400 | 404 | 409 | 503 } {
  if (error instanceof StorageCredentialReenvelopeInputError) return { error: error.message, status: 400 };
  if (error instanceof StorageCredentialReenvelopeError) return { error: error.message, status: error.status };
  return { error: "Storage credential re-envelope is temporarily unavailable.", status: 503 };
}
storageCredentialReenvelopeRoutes.get("/storage/configuration/credential-envelopes", requireSystemAdministrator, async c => {
  try {
    const query = new URL(c.req.url).searchParams;
    if (query.size !== 1 || query.getAll("profileId").length !== 1) throw new StorageCredentialReenvelopeInputError();
    const profileId = checkedStorageCredentialEnvelopeProfileId(query.get("profileId"));
    return c.json(await listStorageCredentialEnvelopes(c.env, profileId, c.get("userEmail")));
  } catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});
storageCredentialReenvelopeRoutes.post("/storage/configuration/credential-reenvelopes", requireSystemAdministrator, limit, async c => {
  if (!jsonContentType(c.req.header("content-type"))) return c.json({ error: "Invalid storage credential re-envelope." }, 400);
  let input;
  try { input = checkedReenvelopeStorageCredentialInput(await c.req.json()); }
  catch { return c.json({ error: "Invalid storage credential re-envelope." }, 400); }
  try { return c.json(await reenvelopeStoredStorageCredential(c.env, input, c.get("userEmail"))); }
  catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});
storageCredentialReenvelopeRoutes.get("/storage/configuration/credential-reenvelopes/:operationId", requireSystemAdministrator, async c => {
  try {
    const operationId = checkedStorageCredentialReenvelopeOperationId(c.req.param("operationId"));
    if (new URL(c.req.url).searchParams.size) throw new StorageCredentialReenvelopeInputError();
    return c.json(await readStorageCredentialReenvelope(c.env, operationId, c.get("userEmail")));
  } catch (error) { const result = failure(error); return c.json({ error: result.error }, result.status); }
});
