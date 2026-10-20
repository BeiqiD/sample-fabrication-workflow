import { Hono } from "hono";
import {
  checkedStorageCandidateReadiness, checkedStorageCandidateReadinessInput,
  StorageCandidateReadinessInputError,
} from "../../shared/contracts/storage-candidate-readiness";
import type { Env } from "../types";
import { readStorageCandidateReadiness, StorageCandidateReadinessError } from "./candidate-readiness-service";
import { requireSystemAdministrator } from "./system-administrator";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageCandidateReadinessRoutes = new Hono<Bindings>();
const unavailable = "Storage candidate readiness is temporarily unavailable.";

storageCandidateReadinessRoutes.get("/storage/configuration/readiness", requireSystemAdministrator, async c => {
  let input;
  try {
    const query = new URL(c.req.url).searchParams;
    const revision = query.get("expectedRevision");
    if (query.size !== 2 || query.getAll("profileId").length !== 1
      || query.getAll("expectedRevision").length !== 1 || revision === null || !/^[1-9][0-9]*$/.test(revision)) {
      throw new StorageCandidateReadinessInputError();
    }
    input = checkedStorageCandidateReadinessInput({ profileId: query.get("profileId"), expectedRevision: Number(revision) });
  } catch {
    return c.json({ error: "Invalid storage candidate readiness request." }, 400);
  }
  try {
    return c.json(checkedStorageCandidateReadiness(await readStorageCandidateReadiness(c.env, input, c.get("userEmail"))));
  } catch (error) {
    if (error instanceof StorageCandidateReadinessError && error.status !== 503) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: unavailable }, 503);
  }
});
