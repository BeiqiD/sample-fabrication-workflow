import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { requireSystemAdministrator } from "../storage/system-administrator";
import { checkedSystemRecoveryMaintenanceInput } from "../../shared/contracts/system-recovery";
import { controlSourceMaintenance, readSourceMaintenance, sourceMaintenanceReceipt } from "./maintenance";

export const maintenanceRoutes = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
maintenanceRoutes.use("/system-recovery/maintenance", requireSystemAdministrator);
maintenanceRoutes.use("/system-recovery/maintenance/*", requireSystemAdministrator);
maintenanceRoutes.get("/system-recovery/maintenance", async c => c.json(await readSourceMaintenance(c.env)));
maintenanceRoutes.get("/system-recovery/maintenance/requests/:requestId", async c => {
  const id = c.req.param("requestId");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HTTPException(400, { message: "Invalid maintenance request ID" });
  const receipt = await sourceMaintenanceReceipt(c.env, c.get("userEmail"), id);
  if (!receipt) throw new HTTPException(404, { message: "Maintenance request has not been accepted" });
  return c.json(receipt);
});
maintenanceRoutes.post("/system-recovery/maintenance", async c => {
  let input;
  try {
    if (!c.req.header("Content-Type")?.startsWith("application/json") || Number(c.req.header("Content-Length") ?? 0) > 4096) throw new Error();
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 4096) { await reader.cancel(); throw new Error(); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    input = checkedSystemRecoveryMaintenanceInput(JSON.parse(text));
  } catch { throw new HTTPException(400, { message: "Invalid source maintenance request" }); }
  return c.json(await controlSourceMaintenance(c.env, c.get("userEmail"), input));
});
