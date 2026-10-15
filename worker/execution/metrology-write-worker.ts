import type { Env } from "../types";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { createMetrologyWriteService } from "./metrology-write-service";
import { createMetrologyWriteHandlers } from "./metrology-write-surface";

/** Actual request-local Worker binding retains mature maintenance/File
 * execution controls. Node supplies real current session/control policy.
 * No File locator, asset input, byte stream or provider is selected here. */
export const metrologyWriteHandlers = createMetrologyWriteHandlers<Env>((_request, env) => createMetrologyWriteService({
  database: () => d1StorageConfigurationDatabase(env.DB),
  admit: async () => { /* Existing genuine Worker middleware/proxies own admission. */ },
  now: Date.now,
  randomId: () => crypto.randomUUID(),
}));
