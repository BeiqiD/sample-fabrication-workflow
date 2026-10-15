import type { Env } from "../types";
import { d1StorageConfigurationDatabase } from "../storage/configuration-d1";
import { createRunTrashService } from "./run-trash-service";
import { createRunTrashHandlers } from "./run-trash-surface";

/** Select the actual current Worker DB binding. Its genuine request-local
 * maintenance/File proxies retain write admission, source leases and late
 * authorization; Node must supply its own genuine principal/control callback.
 * This adapter opens no provider and manufactures neither Env nor D1. */
export const runTrashHandlers = createRunTrashHandlers<Env>((_request, env) => createRunTrashService({
  database: () => d1StorageConfigurationDatabase(env.DB),
  admit: async () => { /* Existing Worker middleware owns current admission. */ },
  now: Date.now,
  randomId: () => crypto.randomUUID(),
}));
