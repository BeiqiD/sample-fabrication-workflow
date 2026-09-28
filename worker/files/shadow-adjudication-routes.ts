import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { checkedShadowAdjudicationRequest, checkedShadowAdjudicationRevocationRequest, MAX_SHADOW_ADJUDICATION_REQUEST_BYTES } from "../../shared/contracts/file-shadow-adjudication";
import { checkedFileShadowReviewKey } from "../../shared/contracts/file-shadow-evidence-review";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { requireFileEvidenceOperator } from "./evidence-operator";
import { assertR2BootstrapProfile } from "./r2-bootstrap-profile";
import { ShadowConflictError, ShadowUnavailableError } from "./shadow-service";
import { acceptShadowAdjudication, prepareShadowAdjudication, readShadowAdjudication,
  revokeShadowAdjudication, withdrawShadowAdjudication, readShadowAdjudicationRevocation, type ShadowAdjudicationContext } from "./shadow-adjudication-service";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const shadowAdjudicationRoutes = new Hono<Bindings>();
shadowAdjudicationRoutes.use("/files/shadow/evidence/*", requireFileEvidenceOperator);
function badInput(): never { throw new HTTPException(400, { message: "Invalid File evidence request" }); }
async function body(request: Request): Promise<unknown> {
  if (!request.body) badInput();
  const reader = request.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let content = "", bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { content += decoder.decode(); break; }
      bytes += next.value.byteLength;
      if (bytes > MAX_SHADOW_ADJUDICATION_REQUEST_BYTES) { await reader.cancel(); badInput(); }
      content += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(content) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof HTTPException) throw error;
    return badInput();
  } finally { reader.releaseLock(); }
}
function checked<T>(value: unknown, check: (value: unknown) => T): T {
  try { return check(value); } catch { return badInput(); }
}
function context(env: Env, actor: string): ShadowAdjudicationContext {
  return { db: env.DB, actor, assertProfile: profile => assertR2BootstrapProfile(primaryD1(env.DB), env, profile.profileId, profile.configurationRevision) };
}
shadowAdjudicationRoutes.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof ShadowConflictError) return c.json({ error: error.message }, 409);
  if (error instanceof ShadowUnavailableError) return c.json({ error: error.message }, 503);
  return c.json({ error: "File evidence state is unavailable or changed. Keep any saved request and inspect it before continuing." }, 409);
});
shadowAdjudicationRoutes.post("/files/shadow/evidence/prepare", async c => {
  const value = await body(c.req.raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("key" in value)) badInput();
  const key = checked((value as { key: unknown }).key, checkedFileShadowReviewKey);
  return c.json(await prepareShadowAdjudication(context(c.env, c.get("userEmail")), key));
});
shadowAdjudicationRoutes.post("/files/shadow/evidence/accept", async c => {
  const input = checked(await body(c.req.raw), checkedShadowAdjudicationRequest);
  return c.json(await acceptShadowAdjudication(context(c.env, c.get("userEmail")), input));
});
shadowAdjudicationRoutes.post("/files/shadow/evidence/request", async c => {
  const input = checked(await body(c.req.raw), checkedShadowAdjudicationRequest);
  const result = await readShadowAdjudication(context(c.env, c.get("userEmail")), input);
  if (!result) throw new HTTPException(404, { message: "No evidence receipt is visible. Keep the original request for readback or durable withdrawal." });
  return c.json(result);
});
shadowAdjudicationRoutes.post("/files/shadow/evidence/withdraw", async c => {
  const input = checked(await body(c.req.raw), checkedShadowAdjudicationRequest);
  return c.json(await withdrawShadowAdjudication(context(c.env, c.get("userEmail")), input));
});
shadowAdjudicationRoutes.post("/files/shadow/evidence/revoke", async c => {
  const input = checked(await body(c.req.raw), checkedShadowAdjudicationRevocationRequest);
  return c.json(await revokeShadowAdjudication(context(c.env, c.get("userEmail")), input));
});

shadowAdjudicationRoutes.post("/files/shadow/evidence/revocation/request", async c => {
  const input = checked(await body(c.req.raw), checkedShadowAdjudicationRevocationRequest);
  const result = await readShadowAdjudicationRevocation(context(c.env, c.get("userEmail")), input);
  if (!result) throw new HTTPException(404, { message: "No revocation receipt is visible. Keep the original revocation for readback or retry." });
  return c.json(result);
});
