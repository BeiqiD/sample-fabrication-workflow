import type { Env } from "../types";
import { d1ProjectReadDatabase } from "./read-d1";
import { createProjectReadService } from "./read-service";
import { createProjectReadHandlers } from "./read-surface";

/** Current Worker middleware owns verified Access/ordinary research admission.
 * Select its current request binding so maintenance/File read proxies remain
 * intact. This adds no provider byte authority or File execution/write lease. */
export const projectReadHandlers = createProjectReadHandlers<Env>((_request, env) => createProjectReadService({
  database: () => d1ProjectReadDatabase(env.DB),
  admit: async () => { /* Existing actual Worker middleware owns read admission. */ },
}));
