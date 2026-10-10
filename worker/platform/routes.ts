import { Hono } from "hono";
import type { ReadinessDatabase } from "../runtime/sql";
import { checkDatabaseReadiness } from "./readiness";

export function createPlatformRoutes<Bindings extends object>(
  selectDatabase: (bindings: Bindings) => ReadinessDatabase,
) {
  const routes = new Hono<{ Bindings: Bindings; Variables: { userEmail: string } }>();
  routes.get("/health", c => c.json({ ok: true }));
  routes.get("/ready", async c => {
    // Resolve inside the request from its current bindings, not an ungated
    // database captured before maintenance/admission clones those bindings.
    await checkDatabaseReadiness(selectDatabase(c.env));
    return c.json({ ok: true });
  });
  return routes;
}
