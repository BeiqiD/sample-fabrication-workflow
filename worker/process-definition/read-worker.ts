import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { createTemplateReadService } from "./read-service";
import { createTemplateReadHandlers } from "./read-surface";

/** Existing actual Worker middleware retains Access/research admission and
 * current maintenance-bound DB ownership. No provider or byte capability. */
export const templateReadHandlers = createTemplateReadHandlers<Env>((_request, env) => createTemplateReadService({
  database: () => d1StorageConfigurationDatabase(env.DB),
  authorityDatabase: () => d1StorageConfigurationDatabase(primaryD1(env.DB)),
  admit: async () => { /* Current Worker verified middleware owns read admission. */ },
}));
