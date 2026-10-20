import type { Env } from "../types";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { createSampleMetadataService } from "./metadata-service";
import { createSampleMetadataHandlers } from "./metadata-surface";

/** Existing Worker authentication admits ordinary research actors. Its
 * request-local maintenance/File proxies still guard every actual D1 call;
 * selecting the current context binding preserves those gates and leases. */
export const sampleMetadataHandlers = createSampleMetadataHandlers<Env>((_request, env) => createSampleMetadataService({
  database: () => d1StorageConfigurationDatabase(env.DB),
  admit: async () => { /* Current Worker middleware owns authentication and write admission. */ },
  now: Date.now,
  randomId: () => crypto.randomUUID(),
}));
