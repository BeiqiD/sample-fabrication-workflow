import type { Env } from "../types";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { createReferenceReadService } from "./read-service";
import { createReferenceReadHandlers } from "./read-surface";

/** Existing actual Worker middleware owns ordinary reference admission. Keep
 * its current DB binding/maintenance proxies and default session selection.
 * There is no provider, File byte, resource ACL or local Env adapter here. */
export const referenceReadHandlers=createReferenceReadHandlers<Env>((_request,env)=>createReferenceReadService({
  database:()=>d1StorageConfigurationDatabase(env.DB),
  admit:async()=>{/* Existing actual Worker middleware owns read admission. */},
}));
