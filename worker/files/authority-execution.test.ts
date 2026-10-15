import { Hono } from "hono";
import { expect, it } from "vitest";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { futureActiveRuntimeDatabase } from "./authority-runtime-test-support";
import { fileAuthorityExecutionAdmission } from "./authority-execution";

it("keeps the installation pause visible when a route catches and translates the admission error", async () => {
  const sql = futureActiveRuntimeDatabase();
  try {
    sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const db = new SqliteD1Database(sql);
    const env = { DB: db as unknown as D1Database, AUTH_MODE: "disabled", ASSETS: {} as R2Bucket } satisfies Env;
    const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");
    app.use("*", fileAuthorityExecutionAdmission);
    app.post("/mutation", async c => {
      try {
        await c.env.DB.prepare("UPDATE samples SET title='Must not execute'").run();
        return c.json({ ok: true });
      } catch {
        return c.json({ error: "Translated business conflict" }, 409);
      }
    });
    const before = sql.prepare("SELECT total_changes() n").get()!.n;
    const response = await app.request("/api/mutation", { method: "POST" }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "File execution is paused on this installation. An operator must enable it after recovery." });
    expect(sql.prepare("SELECT total_changes() n").get()!.n).toBe(before);
    expect(env.DB).toBe(db);
  } finally { sql.close(); }
});
