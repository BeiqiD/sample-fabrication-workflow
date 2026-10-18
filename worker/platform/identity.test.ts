import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCreationSubject } from "../../shared/project-creation-subject";
import { createWorkerApplication } from "../application";
import { workerProjectCreationSubjectScope } from "../projects/creation-subject";
import type { Env } from "../types";
import { createAuthenticationMiddleware } from "./authentication";
import { applicationIdentityAdmission, applicationIdentityRoutes } from "./identity";

const origin = "https://identity.example.test";
const environment = () => ({ AUTH_MODE: "disabled", DB: {
  prepare: vi.fn(() => { throw new Error("Identity must not access the database"); }),
} }) as unknown as Env;
afterEach(() => vi.restoreAllMocks());

describe("application browser request ownership", () => {
  it("exposes only an opaque authenticated subject before database or maintenance access", async () => {
    const env = environment(), app = createWorkerApplication();
    const response = await app.fetch(new Request(`${origin}/api/identity`), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const subject = await projectCreationSubject("local-development", workerProjectCreationSubjectScope(new Request(origin), env));
    expect(await response.json()).toEqual({ schema: "application-identity/1", subject });
    expect(subject).toMatch(/^[a-f0-9]{64}$/);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("does not let a forged subject authenticate a request or reach SQL", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = { ...environment(), AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "https://identity.cloudflareaccess.com", ACCESS_AUD: "fixture-audience" } as Env;
    const app = createWorkerApplication();
    const response = await app.fetch(new Request(`${origin}/api/identity`, {
      headers: { "x-sfw-expected-subject": "a".repeat(64), "x-user-email": "forged@example.test" },
    }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(response.headers.has("x-sfw-identity-result")).toBe(false);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("keeps public health independent of an expired browser owner", async () => {
    const response = await createWorkerApplication().fetch(new Request(`${origin}/api/health`, {
      headers: { "x-sfw-expected-subject": "invalid" },
    }), environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("refuses old-account reads and writes before downstream handlers, and preserves matching/legacy requests", async () => {
    const env = environment();
    let actor = "original-actor";
    const delivered: { actor: string; method: string }[] = [];
    const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");
    app.use("*", createAuthenticationMiddleware(async () => ({ actor })));
    app.use("*", applicationIdentityAdmission);
    app.route("/", applicationIdentityRoutes);
    app.all("/work", c => { delivered.push({ actor: c.get("userEmail"), method: c.req.method }); return c.json({ accepted: true }); });
    const request = (path: string, method = "GET", subject?: string) => app.fetch(new Request(`${origin}/api${path}`, {
      method, headers: { ...(subject === undefined ? {} : { "x-sfw-expected-subject": subject }) },
    }), env);
    const identity = await (await request("/identity")).json() as { subject: string };
    expect((await request("/work", "POST", identity.subject)).status).toBe(200);
    actor = "replacement-actor";
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      const response = await request("/work", method, identity.subject);
      expect(response.status).toBe(409);
      expect(response.headers.get("x-sfw-identity-result")).toBe("mismatch");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      if (method !== "HEAD") expect(JSON.stringify(await response.json())).not.toContain(actor);
    }
    expect((await request("/work", "POST", "invalid")).status).toBe(409);
    expect(delivered).toEqual([{ actor: "original-actor", method: "POST" }]);
    const replacement = await (await request("/identity")).json() as { subject: string };
    expect(replacement.subject).not.toBe(identity.subject);
    expect((await request("/work", "POST", replacement.subject)).status).toBe(200);
    expect((await request("/work", "POST")).status).toBe(200);
    expect(delivered).toHaveLength(3);
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });

  it("does not reuse an owner after the deployment realm changes", async () => {
    const env = environment(), app = createWorkerApplication();
    const request = new Request(`${origin}/api/identity`);
    const original = await (await app.fetch(request, env)).json() as { subject: string };
    const response = await app.fetch(new Request(`${origin}/api/packages`, {
      method: "POST", headers: { "x-sfw-expected-subject": original.subject },
    }), { ...env, ACCESS_AUD: "changed-deployment" });
    expect(response.status).toBe(409);
    expect(response.headers.get("x-sfw-identity-result")).toBe("mismatch");
    expect(env.DB.prepare).not.toHaveBeenCalled();
  });
});
