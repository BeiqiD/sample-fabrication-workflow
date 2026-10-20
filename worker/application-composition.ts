import { Hono, type Env, type ErrorHandler, type MiddlewareHandler } from "hono";

/** These names/order describe existing route owners, not replacement domains. */
export const BEFORE_FILE_AUTHORITY_ROUTE_OWNERS = ["maintenance", "systemRecovery", "storageConfiguration"] as const;
export const AFTER_FILE_AUTHORITY_ROUTE_OWNERS = ["platform", "storageSettings", "fileAuthority", "migration", "package",
  "commentSubmission", "projectFoundation", "exportSnapshot", "shadow", "fileEvidenceAccess", "shadowAdjudication",
  "project", "reference", "sample", "execution", "legacyEvidence", "executionVerification", "attachment",
  "exportBlob", "fabublox", "processDefinition"] as const;
export type ApplicationRouteOwner = typeof BEFORE_FILE_AUTHORITY_ROUTE_OWNERS[number] | typeof AFTER_FILE_AUTHORITY_ROUTE_OWNERS[number];
export type ApplicationRouteMount<E extends Env> = (application: Hono<E>) => void;
export type ApplicationRouteMounts<E extends Env> = Readonly<Record<ApplicationRouteOwner, ApplicationRouteMount<E> | "unavailable">>;

/** The complete Worker and an explicitly partial runtime share installation
 * order. Runtime owners provide authentication/admission and genuine routes;
 * unavailable mounts never become fabricated business capabilities. */
export function composeApiApplication<E extends Env>(options: {
  handleError: ErrorHandler<E>;
  storageSettingsCacheControl: MiddlewareHandler<E>;
  storageConfigurationCacheControl: MiddlewareHandler<E>;
  authenticate: MiddlewareHandler<E>;
  sourceMaintenanceAdmission: MiddlewareHandler<E>;
  fileAuthorityExecutionAdmission: MiddlewareHandler<E>;
  routeMounts: ApplicationRouteMounts<E>;
  /** Runtime-local login/session transport only; absent for Cloudflare. */
  publicAuthenticationRoutes?: ApplicationRouteMount<E>;
}) {
  const app = new Hono<E>().basePath("/api");
  app.onError(options.handleError);
  app.use("/settings/storage", options.storageSettingsCacheControl);
  app.use("/settings/storage/*", options.storageSettingsCacheControl);
  app.use("/files/migrations", options.storageSettingsCacheControl);
  app.use("/files/migrations/*", options.storageSettingsCacheControl);
  app.use("/storage/configuration", options.storageConfigurationCacheControl);
  app.use("/storage/configuration/*", options.storageConfigurationCacheControl);
  options.publicAuthenticationRoutes?.(app);
  app.use("*", options.authenticate);
  app.use("*", options.sourceMaintenanceAdmission);
  for (const name of BEFORE_FILE_AUTHORITY_ROUTE_OWNERS) {
    const mount = options.routeMounts[name]; if (mount !== "unavailable") mount(app);
  }
  app.use("*", options.fileAuthorityExecutionAdmission);
  for (const name of AFTER_FILE_AUTHORITY_ROUTE_OWNERS) {
    const mount = options.routeMounts[name]; if (mount !== "unavailable") mount(app);
  }
  return app;
}
