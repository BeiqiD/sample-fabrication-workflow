import { Hono } from "hono";
import type { Env } from "../types";
import { canAdministerSystemSettings } from "./system-administrator";
import { createStorageConfigurationCacheControl, createStorageConfigurationSurface } from "./configuration-surface";
import { readStorageConfiguration, saveStorageCandidate, storageCredentialEditingAvailable, StorageConfigurationError } from "./configuration-registry";
import { storageCandidateCheckRoutes } from "./candidate-check-routes";
import { storageCandidateReadinessRoutes } from "./candidate-readiness-routes";
import { storageCredentialReenvelopeRoutes } from "./credential-reenvelope-routes";
import { storageProfileAdmissionRoutes } from "./storage-profile-admission-routes";
import { storagePolicyRoutes } from "./policy-routes";

type Bindings = { Bindings: Env; Variables: { userEmail: string } };
export const storageConfigurationRoutes = new Hono<Bindings>();
storageConfigurationRoutes.route("/", storageCandidateCheckRoutes);
storageConfigurationRoutes.route("/", storageCandidateReadinessRoutes);
storageConfigurationRoutes.route("/", storageCredentialReenvelopeRoutes);
storageConfigurationRoutes.route("/", storageProfileAdmissionRoutes);
storageConfigurationRoutes.route("/", storagePolicyRoutes);
/** Installed before authentication, including its error responses. */
export const storageConfigurationCacheControl = createStorageConfigurationCacheControl<Env>();
storageConfigurationRoutes.route("/", createStorageConfigurationSurface<Env>({
  authorizeAdministrator: (_request, env, actor) => canAdministerSystemSettings(env, actor),
  credentialEditingAvailable: storageCredentialEditingAvailable,
  read: readStorageConfiguration,
  save: saveStorageCandidate,
  routeError: error => error instanceof StorageConfigurationError ? { status: error.status, message: error.message } : null,
}));
