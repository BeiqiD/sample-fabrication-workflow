import type { Env } from "../types";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { createSampleReadService } from "./read-service";
import { createSampleReadHandlers } from "./read-surface";

/** The existing Worker middleware owns Access authentication and read fences.
 * Selecting its current request binding keeps actual maintenance/File proxies
 * intact, without adding a File execution/write lease to these reads. */
export const sampleReadHandlers = createSampleReadHandlers<Env>((_request, env) => createSampleReadService({
  database: () => d1StorageConfigurationDatabase(env.DB),
  admit: async () => { /* Current Worker middleware owns read admission. */ },
}));
