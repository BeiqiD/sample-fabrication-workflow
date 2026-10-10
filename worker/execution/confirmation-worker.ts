import type { Env } from "../types";
import { d1StepConfirmationDatabase } from "./confirmation-d1";
import { createStepConfirmationService } from "./confirmation-service";
import { createStepConfirmationHandlers } from "./confirmation-surface";

/** Existing Worker authentication and request-local maintenance/File SQL
 * proxies own admission. Node composers must supply their genuine current
 * principal/original Request admission separately; actor syntax is no grant. */
export const stepConfirmationHandlers = createStepConfirmationHandlers<Env>((_request, env) => createStepConfirmationService({
  database: () => d1StepConfirmationDatabase(env.DB),
  admit: async () => { /* Current Worker middleware owns authentication and write admission. */ },
  now: Date.now,
  randomId: () => crypto.randomUUID(),
}));
