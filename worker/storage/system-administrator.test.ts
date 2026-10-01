import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { handleError } from "../platform/http";
import type { Env } from "../types";
import { assertSystemAdministrator, canAdministerSystemSettings, requireSystemAdministrator } from "./system-administrator";

describe("system administrator boundary", () => {
  it("requires a separately configured administrator from verified Access claims", () => {
    const env = { AUTH_MODE: "access", ALLOWED_EMAILS: "reader@example.org", FILE_EVIDENCE_OPERATOR_EMAILS: "reader@example.org" } as Env;
    expect(canAdministerSystemSettings(env, "reader@example.org")).toBe(false);
    expect(canAdministerSystemSettings({ ...env, SYSTEM_ADMIN_EMAILS: " Admin@Example.org , second@example.org " }, "ADMIN@example.org")).toBe(true);
    expect(canAdministerSystemSettings({ ...env, SYSTEM_ADMIN_EMAILS: "admin@example.org" }, "reader@example.org")).toBe(false);
  });

  it("does not grant administrator access in local mode or from invalid principal values", () => {
    expect(canAdministerSystemSettings({ AUTH_MODE: "disabled", SYSTEM_ADMIN_EMAILS: "admin@example.org" }, "admin@example.org")).toBe(false);
    for (const email of ["local-development", "", " admin@example.org", "admin@example.org\0", "admin@example.org\nreader@example.org"]) {
      expect(canAdministerSystemSettings({ AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org" }, email)).toBe(false);
    }
  });

  it("does not partly grant a missing, malformed, or unbounded administrator policy", () => {
    for (const list of [undefined, "", " ", "*", "@example.org", "admin@example.org,", "admin@example.org,*", "admin@example.org,broken",
      "admin@example.org\0", "admin@example.org\nreader@example.org", "a".repeat(8193), Array(51).fill("admin@example.org").join(",")]) {
      expect(canAdministerSystemSettings({ AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: list }, "admin@example.org")).toBe(false);
    }
  });

  it("returns a fixed forbidden error without disclosing administrator identities", () => {
    const error = (() => {
      try { assertSystemAdministrator({ AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org" }, "reader@example.org"); }
      catch (error) { return error; }
    })();
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(403);
    expect((error as Error).message).toBe("System administrator access is required.");
    expect(() => assertSystemAdministrator({ AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org" }, "admin@example.org")).not.toThrow();
  });

  function app(verifiedEmail: string) {
    const endpoint = vi.fn((c: { json(value: unknown): Response }) => c.json({ ok: true }));
    const router = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
    router.onError(handleError);
    // In production the existing parent sets this only after JWT verification.
    router.use("*", async (c, next) => { c.set("userEmail", verifiedEmail); await next(); });
    router.use("/settings/*", requireSystemAdministrator);
    router.post("/settings/candidate", endpoint);
    return { router, endpoint };
  }

  it("rejects forged request headers and existing File operator permission before a privileged handler runs", async () => {
    const { router, endpoint } = app("reader@example.org");
    const env = { AUTH_MODE: "access", ALLOWED_EMAILS: "reader@example.org", FILE_EVIDENCE_OPERATOR_EMAILS: "reader@example.org",
      SYSTEM_ADMIN_EMAILS: "admin@example.org" } as Env;
    const response = await router.request("/settings/candidate", { method: "POST",
      headers: { "x-user-email": "admin@example.org", "cf-access-authenticated-user-email": "admin@example.org" }, body: "not JSON" }, env);
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "System administrator access is required." });
    expect(endpoint).not.toHaveBeenCalled();
  });

  it("rechecks administrator policy for each request and does not cache a previous grant", async () => {
    const { router, endpoint } = app("admin@example.org");
    const env = { AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org" } as Env;
    const accepted = await router.request("/settings/candidate", { method: "POST" }, env);
    expect(accepted.status).toBe(200); expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(await accepted.json()).toEqual({ ok: true });
    expect((await router.request("/settings/candidate", { method: "POST" }, { ...env, SYSTEM_ADMIN_EMAILS: "" })).status).toBe(403);
    expect(endpoint).toHaveBeenCalledOnce();
  });
});
