import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedResearchRequestAbsent, checkedResearchRequestReceipt } from "../../shared/contracts/research-package-api";
import type { Env } from "../types";
import { nativeAcceptanceFixture } from "../uploads/native-acceptance-test-support";
import { packageRoutes } from "./routes";
import { SqlPackageRepository } from "./jobs/sql-repository";

const fixtures: Awaited<ReturnType<typeof nativeAcceptanceFixture>>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fixtures.splice(0).forEach(value => value.sql.close()); });
async function fixture() {
  const f = await nativeAcceptanceFixture(true, { throughMigration: "0020_fp4_research_packages.sql" }); fixtures.push(f);
  Object.assign(f.env, { ACCESS_TEAM_DOMAIN: "qualification.cloudflareaccess.com", ACCESS_AUD: "package-absence", ALLOWED_EMAILS: `${f.actor},other@example.test` });
  const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
  app.use("*", async (c, next) => { c.set("userEmail", c.req.header("X-Fixture-Actor") ?? f.actor); await next(); });
  app.route("/api", packageRoutes);
  f.s3Fetch.mockClear(); f.r2Put.mockClear(); f.r2Get.mockClear(); f.r2Delete.mockClear();
  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`https://qualification.test/api/packages${path}`, init), f.env);
  const input = { requestId: crypto.randomUUID(), byteSize: 22, sha256: "a".repeat(64) };
  return { ...f, request, input };
}

describe("actual Package request absence routes", () => {
  it("returns actor-scoped typed absence, then reconciles a later accepted original without provider or lookup writes", async () => {
    const f = await fixture(), path = `/requests/${f.input.requestId}`;
    const before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const absent = await f.request(path); expect(absent.status).toBe(404);
    expect(absent.headers.get("content-type")).toMatch(/^application\/json/);
    expect(absent.headers.get("cache-control")).toBe("private, no-store");
    expect(checkedResearchRequestAbsent(await absent.json(), f.input.requestId)).toEqual({ schema: "research-package-request-absent/1", requestId: f.input.requestId });
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    const accepted = await f.request("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.input) });
    expect(accepted.status).toBe(202); const original = checkedResearchRequestReceipt(await accepted.json());
    const afterAcceptance = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const response = await f.request(path); expect(response.status).toBe(200);
    expect(checkedResearchRequestReceipt(await response.json())).toEqual(original);
    const privateResponse = await f.request(path, { headers: { "X-Fixture-Actor": "other@example.test" } });
    expect(privateResponse.status).toBe(404);
    expect(checkedResearchRequestAbsent(await privateResponse.json(), f.input.requestId).requestId).toBe(f.input.requestId);
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(afterAcceptance);
    const changed = await f.request("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f.input, byteSize: 23 }) });
    expect(changed.status).toBe(409);
    expect(f.sql.prepare("SELECT count(*) n FROM research_package_jobs").get()!.n).toBe(1);
    expect(f.s3Fetch).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
  });

  it("refuses absence after access revocation or an original request abort during the actual lookup", async () => {
    const f = await fixture(), original = SqlPackageRepository.prototype.request;
    let revoke = true; const abort = new AbortController();
    vi.spyOn(SqlPackageRepository.prototype, "request").mockImplementation(async function (this: SqlPackageRepository, ...args) {
      const value = await original.apply(this, args);
      if (revoke) f.env.ALLOWED_EMAILS = "replacement@example.test"; else abort.abort();
      return value;
    });
    const before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    expect((await f.request(`/requests/${f.input.requestId}`)).status).toBe(403);
    f.env.ALLOWED_EMAILS = f.actor; revoke = false;
    expect((await f.request(`/requests/${f.input.requestId}`, { signal: abort.signal })).status).toBe(409);
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(f.s3Fetch).not.toHaveBeenCalled(); expect(f.r2Put).not.toHaveBeenCalled(); expect(f.r2Get).not.toHaveBeenCalled();
  });
});
