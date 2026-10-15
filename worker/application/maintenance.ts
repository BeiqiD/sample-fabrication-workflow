import { runBlobGarbageCollection } from "../blob-lifecycle/gc";
import { closeExpiredRetryWindows } from "../evidence/retry-maintenance";
import { reapStaleFabubloxImports } from "../fabublox-import-recovery";
import type { Env } from "../types";
import { ensureFileAuthorityExecution } from "../files/authority-execution";

// Source owners release expired retention before physical GC discovers work.
// Keep one clock and preserve the ordered stages and their failure propagation.
export async function runApplicationMaintenance(env: Env, now = new Date()) {
  await ensureFileAuthorityExecution(env.DB);
  const staleImports = await reapStaleFabubloxImports(env, now);
  const retry = await closeExpiredRetryWindows(env, now);
  const gc = await runBlobGarbageCollection(env, now);
  return { ...staleImports, ...retry, ...gc };
}
