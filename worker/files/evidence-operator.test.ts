import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { handleError } from "../platform/http";
import type { Env } from "../types";
import { canAdjudicateFileEvidence, fileEvidenceAccessRoutes, requireFileEvidenceOperator } from "./evidence-operator";

describe("File evidence operator boundary", () => {
  it("requires an explicitly configured operator under Access authentication", () => {
    for (const list of [undefined, "", " ", "*", "@example.org", "operator@example.org,", "operator@example.org,*", "operator@example.org,broken"]) {
      expect(canAdjudicateFileEvidence({ AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: list }, "operator@example.org")).toBe(false);
    }
    expect(canAdjudicateFileEvidence({ AUTH_MODE: "disabled", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org" }, "operator@example.org")).toBe(false);
    expect(canAdjudicateFileEvidence({ AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org" }, "local-development")).toBe(false);
    expect(canAdjudicateFileEvidence({ AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: " Operator@Example.org , second@example.org " }, "OPERATOR@example.org")).toBe(true);
    expect(canAdjudicateFileEvidence({ AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org" }, "other@example.org")).toBe(false);
    expect(canAdjudicateFileEvidence({ AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org" }, " operator@example.org")).toBe(false);
  });

  it("bounds configuration and rejects control characters or partial invalid lists", () => {
    for (const list of ["operator@example.org\0", "operator@example.org\nother@example.org", "a".repeat(8193), Array(51).fill("operator@example.org").join(",")]) {
      expect(canAdjudicateFileEvidence({ AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: list }, "operator@example.org")).toBe(false);
    }
  });

  function app(actor: string) {
    const endpoint = vi.fn((c: { json: (value: unknown) => Response }) => c.json({ ok: true }));
    const router = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
    router.onError(handleError);
    // The production parent supplies this only after JWT verification.
    router.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    router.route("/", fileEvidenceAccessRoutes);
    router.use("/files/shadow/evidence/*", requireFileEvidenceOperator);
    for (const name of ["prepare", "accept", "request", "withdraw", "revoke", "revocation/request"]) router.post(`/files/shadow/evidence/${name}`, endpoint);
    return { router, endpoint };
  }

  it("does not turn application allowlisting or forged request identities into operator authority", async () => {
    const { router, endpoint } = app("reader@example.org");
    const env = { AUTH_MODE: "access", ALLOWED_EMAILS: "reader@example.org", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org" } as Env;
    for (const action of ["prepare", "accept", "request", "withdraw", "revoke", "revocation/request"]) {
      const response = await router.request(`/files/shadow/evidence/${action}`, { method: "POST", headers: { "x-user-email": "operator@example.org", "cf-access-authenticated-user-email": "operator@example.org" }, body: "not even JSON" }, env);
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "File evidence operator access is required." });
    }
    expect(endpoint).not.toHaveBeenCalled();
    const capabilities = await router.request("/files/shadow/evidence/capabilities", {}, env);
    expect(await capabilities.json()).toEqual({ canAdjudicate: false });
    expect(capabilities.headers.get("cache-control")).toBe("no-store");
  });

  it("checks deployment policy again on each request and exposes no allowlist", async () => {
    const { router, endpoint } = app("operator@example.org");
    const env = { AUTH_MODE: "access", FILE_EVIDENCE_OPERATOR_EMAILS: "operator@example.org" } as Env;
    expect(await (await router.request("/files/shadow/evidence/capabilities", {}, env)).json()).toEqual({ canAdjudicate: true });
    expect((await router.request("/files/shadow/evidence/accept", { method: "POST" }, env)).status).toBe(200);
    expect((await router.request("/files/shadow/evidence/accept", { method: "POST" }, { ...env, FILE_EVIDENCE_OPERATOR_EMAILS: "" })).status).toBe(403);
    expect(endpoint).toHaveBeenCalledOnce();
  });
});
