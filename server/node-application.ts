import { createProjectItemMetadataService } from "../worker/projects/item-metadata-service";
import { createProjectItemMetadataHandlers } from "../worker/projects/item-metadata-surface";
import { asProjectItemMetadataDatabase } from "./project-item-metadata-sql";
import { createProjectEdgeService } from "../worker/projects/edge-service";
import { createProjectEdgeHandlers } from "../worker/projects/edge-surface";
import { asProjectEdgeDatabase } from "./project-edge-sql";
import { createProjectLifecycleService } from "../worker/projects/lifecycle-service";
import { createProjectLifecycleHandlers } from "../worker/projects/lifecycle-surface";
import { asProjectLifecycleDatabase } from "./project-lifecycle-sql";
import { createTemplateStepDeleteService } from "../worker/process-definition/template-step-delete-service";
import { createTemplateStepDeleteHandlers } from "../worker/process-definition/template-step-delete-surface";
import { asTemplateStepDeleteDatabase } from "./template-step-delete-sql";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { composeApiApplication, BEFORE_FILE_AUTHORITY_ROUTE_OWNERS, AFTER_FILE_AUTHORITY_ROUTE_OWNERS,
  type ApplicationRouteMounts } from "../worker/application-composition";
import { createApiErrorHandler } from "../worker/platform/errors";
import { createPlatformRoutes } from "../worker/platform/routes";
import { createFileEvidenceAccessRoutes } from "../worker/runtime/authorization";
import { createStorageConfigurationCacheControl, createStorageConfigurationSurface } from "../worker/storage/configuration-surface";
import { AdministratorDenied, createStorageConfigurationRegistry, StorageConfigurationError } from "../worker/storage/configuration-registry-core";
import type { StorageCredentialKeyring } from "../worker/storage/credential-envelope";
import { createInstalledLocalIdentity, type IdentityPolicy } from "./auth/identity";
import { createLocalAuthentication, type LocalAuthEnvironment } from "./auth/local-auth-http";
import { createLoopbackLocalAuthTransport } from "./auth/local-auth-transport";
import type { PasswordHasher } from "./auth/passwords";
import { createNodeHttpServer, stopNodeHttpServerAndDrain, type FetchHandler, type NodeHttpOptions } from "./http";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "./migrations";
import { asReadinessDatabase, assertSqliteConnectionOwner, type SqliteCapability } from "./sqlite";
import { createStaticAssetsHandler } from "./static-assets";
import { asStorageConfigurationSqlDatabase } from "./storage-configuration-sql";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "./operations/writer-lease";
import { createSampleMetadataService } from "../worker/samples/metadata-service";
import { createSampleMetadataHandlers } from "../worker/samples/metadata-surface";
import { createSampleReadService } from "../worker/samples/read-service";
import { createSampleReadSurface } from "../worker/samples/read-surface";
import { createProjectReadService } from "../worker/projects/read-service";
import { createProjectReadSurface } from "../worker/projects/read-surface";
import { createTemplateLifecycleService } from "../worker/process-definition/template-lifecycle-service";
import { createTemplateLifecycleHandlers } from "../worker/process-definition/template-lifecycle-surface";
import { asTemplateLifecycleDatabase } from "./template-lifecycle-sql";
import { createMetrologyDefinitionService } from "../worker/process-definition/metrology-definition-service";
import { createMetrologyDefinitionHandlers } from "../worker/process-definition/metrology-definition-surface";
import { asMetrologyDefinitionDatabase } from "./metrology-definition-sql";
import { createTemplateReadService } from "../worker/process-definition/read-service";
import { createTemplateReadSurface } from "../worker/process-definition/read-surface";
import { asProjectReadDatabase } from "./project-read-sql";
import { createReferenceReadService } from "../worker/references/read-service";
import { createReferenceReadHandlers } from "../worker/references/read-surface";
import { createProjectCreationService } from "../worker/projects/create-service";
import { createProjectCreationHandlers } from "../worker/projects/create-surface";
import { asProjectCreateDatabase } from "./project-create-sql";
import { createProjectRenameService } from "../worker/projects/rename-service";
import { createProjectRenameHandlers } from "../worker/projects/rename-surface";
import { asProjectRenameDatabase } from "./project-rename-sql";
import { createProjectWorkspaceService } from "../worker/projects/workspace-service";
import { createProjectWorkspaceHandlers } from "../worker/projects/workspace-surface";
import { asProjectWorkspaceDatabase } from "./project-workspace-sql";
import { projectCreationSubject } from "../shared/project-creation-subject";
import { createResearchWriteAdmission } from "./auth/research-write-admission";
import { createStorageConfigurationWriteAdmission } from "./auth/storage-configuration-write-admission";
import { createRunTrashService } from "../worker/execution/run-trash-service";
import { createRunTrashHandlers } from "../worker/execution/run-trash-surface";
import { createMetrologyWriteService } from "../worker/execution/metrology-write-service";
import { createMetrologyWriteHandlers } from "../worker/execution/metrology-write-surface";
import { createStepConfirmationService } from "../worker/execution/confirmation-service";
import { createStepConfirmationHandlers } from "../worker/execution/confirmation-surface";
import { asStepConfirmationDatabase } from "./step-confirmation-sql";
import { createExecutionPreviewService } from "../worker/execution/preview-service";
import { createExecutionPreviewHandlers } from "../worker/execution/preview-surface";
import { createRunFinishService } from "../worker/execution/run-finish-service";
import { createRunFinishHandlers } from "../worker/execution/run-finish-surface";
import { asRunFinishDatabase } from "./run-finish-sql";
import { createRunPlanService } from "../worker/execution/run-plan-service";
import { createRunPlanHandlers } from "../worker/execution/run-plan-surface";
import { asRunPlanDatabase } from "./run-plan-sql";
import { assertNodeRuntimeConfiguration, type LoadedNodeRuntimeConfiguration } from "./node-runtime-config";
import { createNodeLocalFileHost } from "./files/node-local-file-host";

interface NodeApplicationBindings { readonly database: SqliteCapability }
type NodeApplicationEnvironment = LocalAuthEnvironment<NodeApplicationBindings>;
const unavailable = () => Response.json({ error: "This feature is unavailable in the local development runtime." },
  { status: 503, headers: { "Cache-Control": "private, no-store" } });
const claimedDevelopmentOwners = new WeakSet<LinuxWriterLease>();
// First failed close retains the whole issued application/native/physical graph.
const failedDevelopmentOwners = new Set<object>();
interface LocalFileConstructionCustody {
  hostAttempted: boolean;
  host?: ReturnType<typeof createNodeLocalFileHost>;
  transportAttempted: boolean;
  server?: Server;
  cleanup?: Promise<void>;
}
export class NodeDevelopmentConstructionDrainError extends AggregateError {
  declare readonly retainedOwners: readonly unknown[];
  constructor(errors: readonly unknown[], owners: readonly unknown[]) {
    super(errors, "Original local runtime construction ownership could not drain");
    this.name = "NodeDevelopmentConstructionDrainError";
    Object.defineProperty(this, "retainedOwners", { value: Object.freeze([...owners]) });
  }
}

/** These concrete methods do not supply the other methods of these owners.
 * The exact listed metadata methods supply this partial development surface. */
export const NODE_DEVELOPMENT_BUSINESS_ROUTES = Object.freeze([
  { owner: "sample", method: "GET", path: "/sample-directory-options" },
  { owner: "sample", method: "GET", path: "/samples" },
  { owner: "sample", method: "GET", path: "/samples/:id" },
  { owner: "sample", method: "POST", path: "/samples" },
  { owner: "sample", method: "PATCH", path: "/samples/:id" },
  { owner: "sample", method: "DELETE", path: "/samples/:id" },
  { owner: "sample", method: "POST", path: "/samples/:id/restore" },
  { owner: "project", method: "GET", path: "/projects" },
  { owner: "project", method: "GET", path: "/projects/:projectId" },
  { owner: "project", method: "POST", path: "/projects" },
  { owner: "project", method: "PATCH", path: "/projects/:projectId" },
  { owner: "processDefinition", method: "GET", path: "/template-families/options" },
  { owner: "processDefinition", method: "GET", path: "/template-families" },
  { owner: "processDefinition", method: "GET", path: "/template-families/:id/versions" },
  { owner: "processDefinition", method: "GET", path: "/metrology-templates" },
  { owner: "processDefinition", method: "GET", path: "/templates" },
  { owner: "processDefinition", method: "GET", path: "/templates/:id" },
  { owner: "reference", method: "POST", path: "/references/resolve" },
  { owner: "reference", method: "POST", path: "/references/children" },
  { owner: "reference", method: "POST", path: "/references/search" },
  { owner: "execution", method: "DELETE", path: "/samples/:sampleId/runs/:runId" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/restore" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/metrology" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/metrology-runs" },
  { owner: "executionVerification", method: "POST", path: "/run-steps/confirm" },
  { owner: "execution", method: "POST", path: "/samples/:id/runs/preview" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/plan-update/preview" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/finish" },
  { owner: "project", method: "POST", path: "/projects/:projectId/items/markdown" },
  { owner: "project", method: "PATCH", path: "/projects/:projectId/contents/:contentId/markdown" },
  { owner: "project", method: "PATCH", path: "/projects/:projectId/placements/:placementId" },
  { owner: "execution", method: "POST", path: "/samples/:id/runs" },
  { owner: "execution", method: "POST", path: "/samples/:sampleId/runs/:runId/plan-update" },
  { owner: "processDefinition", method: "POST", path: "/metrology-templates" },
  { owner: "processDefinition", method: "PATCH", path: "/metrology-templates/:id" },
  { owner: "processDefinition", method: "PATCH", path: "/metrology-templates/:id/notes" },
  { owner: "processDefinition", method: "PATCH", path: "/templates/:id" },
  { owner: "processDefinition", method: "DELETE", path: "/templates/:id" },
  { owner: "processDefinition", method: "POST", path: "/templates/:id/restore" },
  { owner: "project", method: "DELETE", path: "/projects/:projectId" },
  { owner: "project", method: "POST", path: "/projects/:projectId/restore" },
  { owner: "processDefinition", method: "DELETE", path: "/templates/:templateId/steps/:stepId" },
  { owner: "project", method: "POST", path: "/projects/:projectId/edges" },
  { owner: "project", method: "PATCH", path: "/projects/:projectId/edges/:edgeId" },
  { owner: "project", method: "DELETE", path: "/projects/:projectId/edges/:edgeId" },
  { owner: "project", method: "POST", path: "/projects/:projectId/edges/:edgeId/restore" },
  { owner: "project", method: "POST", path: "/projects/:projectId/items/reference" },
  { owner: "project", method: "PATCH", path: "/projects/:projectId/contents/:contentId/attachment" },
  { owner: "project", method: "DELETE", path: "/projects/:projectId/items/:itemId" },
].map(route => Object.freeze(route)));
export const NODE_PARTIAL_ROUTE_OWNERS = Object.freeze(["sample", "project", "processDefinition", "reference", "execution", "executionVerification"] as const);
export const MAX_NODE_SAMPLE_METADATA_BYTES = 65_536;
// Supports all 200 accepted target IDs even when every UTF-16 character needs
// a six-byte JSON escape; ignored extra input is still bounded at the ingress.
export const MAX_NODE_REFERENCE_INPUT_BYTES = 524_288;
// All three mature accepted fields fit even with maximum JSON escaping.
export const MAX_NODE_PROJECT_CREATE_BYTES = 8192;
// Mature title, expected revision and operation ID fit at maximum escaping.
export const MAX_NODE_PROJECT_RENAME_BYTES = 8192;
// 200,000 accepted Markdown code points fit even when each astral point needs
// two six-byte JSON escapes, together with original IDs/CAS/geometry fields.
export const MAX_NODE_PROJECT_WORKSPACE_BYTES = 2_500_000;
// Explicit bound for the new partial Node metadata surface. Mature services
// still validate their own fields and grouped confirmation's 1–12 targets.
export const MAX_NODE_EXECUTION_METADATA_BYTES = 65_536;
// Original maximum UTF-16 field lengths fit even at six-byte JSON escaping.
export const MAX_NODE_METROLOGY_DEFINITION_BYTES = 131_072;
// The original rename fields fit even with six-byte JSON escaping.
export const MAX_NODE_TEMPLATE_LIFECYCLE_BYTES = 4_096;
// Original operation ID and expected revision fit at maximum JSON escaping.
export const MAX_NODE_PROJECT_LIFECYCLE_BYTES = 4_096;
// Four maximum code-point IDs/op ID and label fit with twelve-byte astral JSON escaping.
export const MAX_NODE_PROJECT_EDGE_BYTES = 16_384;
// Original caption/sourceURL maxima and reference IDs fit at full JSON escaping.
export const MAX_NODE_PROJECT_ITEM_METADATA_BYTES = 65_536;
const businessAdmissions = NODE_DEVELOPMENT_BUSINESS_ROUTES.map(route => ({ method: route.method,
  pattern: new RegExp(`^/api${route.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`) }));
function businessMethodAdmitted(method: string, path: string): boolean {
  return businessAdmissions.some(route => route.method === method && route.pattern.test(path));
}

/** Exact current client graph admission only. Static HTML does not make the
 * underlying research/provider/job routes supported by this partial runtime. */
export function isNodeClientSpaPath(path: string): boolean {
  return /^(?:\/|\/processing(?:\/[^/]+)?|\/samples(?:\/new|\/[^/]+(?:\/timeline)?)?|\/projects(?:\/[^/]+)?|\/search|\/templates(?:\/metrology\/[^/]+|\/[^/]+)?|\/references\/[^/]+\/[^/]+|\/imports\/fabublox|\/export|\/settings\/data(?:\/system)?|\/settings\/storage(?:\/configuration|\/migrations)?|\/maintenance\/(?:file-shadow|file-evidence|file-authority))$/.test(path);
}

/** Source prototype only until its actual HTTP/current installation fixture is
 * qualified. No D1/R2/Env facade, application migrations, offline bootstrap,
 * byte/profile activation or scheduled business writer is installed here.
 * Caller acquires the physical lease before native open/install and binds the
 * genuine native/core tuple. Once accepted, this composer owns connection and
 * lease shutdown. Admitted schema/ledger/identity remain immutable for that
 * lifetime. Stop/discard before migration/recovery; restart uses fresh owners.
 * TLS/proxy ingress and unsupported business methods remain unavailable. */
export async function createNodeDevelopmentPrototype(options: {
  writerLease: LinuxWriterLease;
  nativeDatabase: DatabaseSync;
  database: SqliteCapability;
  admission: ReviewedInstallationAdmission;
  hasher: PasswordHasher;
  identityPolicy: IdentityPolicy;
  now: () => number;
  publicOrigin: string;
  clientDirectory: string;
  /** Installation-owned encryption; absence preserves unavailable status. */
  keyring?: () => Promise<StorageCredentialKeyring>;
  /** Explicit factory-issued deployment configuration. No runtime default,
   * provisioning, role or startup activation is supplied by this option. */
  localFileConfiguration?: LoadedNodeRuntimeConfiguration;
  httpLimits?: Omit<NodeHttpOptions, "publicOrigin" | "requestAdmission">;
}): Promise<{
  server: Server;
  close(): Promise<void>;
  /** Explicit trusted scheduler slot, never a request-supplied execution grant. */
  dispatchFileJobsOnce(): Promise<{ readonly jobId: string | null; readonly outcome: string }>;
  readonly unsupportedRouteOwners: readonly string[];
}> {
  // Capture one actual owner tuple and policy before any constructor KDF.
  const captured = Object.freeze({ ...options, identityPolicy: Object.freeze({ ...options.identityPolicy }),
    httpLimits: options.httpLimits === undefined ? undefined : Object.freeze({ ...options.httpLimits }) });
  assertLinuxWriterLeaseBinding(captured.writerLease, captured.database, captured.nativeDatabase);
  assertInstallationAdmission(captured.nativeDatabase, captured.admission);
  createLoopbackLocalAuthTransport({ publicOrigin: captured.publicOrigin });
  if (captured.localFileConfiguration !== undefined) {
    const configuration = assertNodeRuntimeConfiguration(captured.localFileConfiguration);
    if (configuration.publicOrigin !== captured.publicOrigin || configuration.clientDirectory !== captured.clientDirectory)
      throw new Error("Original local runtime configuration is required.");
  }
  if (claimedDevelopmentOwners.has(captured.writerLease)) throw new Error("Local runtime writer ownership is already assigned.");
  claimedDevelopmentOwners.add(captured.writerLease);
  const fileCustody: LocalFileConstructionCustody = { hostAttempted: false, transportAttempted: false };
  const construction = captured.writerLease.withWriter(() => constructLeasedDevelopmentPrototype(captured, fileCustody));
  try {
    return await construction;
  } catch (constructionError) {
    if (fileCustody.hostAttempted) {
      // An attempted constructor with no returned original handle cannot be
      // closed by raw Native fallback, even if the reported handle is closed.
      if (!fileCustody.host || fileCustody.transportAttempted && !fileCustody.server) {
        const error = new NodeDevelopmentConstructionDrainError([constructionError], [captured, construction, fileCustody]);
        failedDevelopmentOwners.add({ captured, construction, fileCustody, error });
        throw error;
      }
      fileCustody.host.stopAdmission();
      fileCustody.cleanup = fileCustody.server ? fileCustody.host.drainAfterTransport(fileCustody.server)
        : fileCustody.host.closeBeforeTransport();
      try { await fileCustody.cleanup; }
      catch (cleanupError) {
        const error = new NodeDevelopmentConstructionDrainError([constructionError, cleanupError], [captured, construction, fileCustody]);
        failedDevelopmentOwners.add({ captured, construction, fileCustody, error });
        throw error;
      }
    }
    // The original constructor has settled. Only its first complete close ACK
    // permits release; closed native state cannot erase a reported failure.
    try { await closeLeasedSqliteOwner(captured.writerLease, captured.database, captured.nativeDatabase); }
    catch (cleanupError) {
      failedDevelopmentOwners.add({ captured, construction, constructionError, cleanupError });
      throw new AggregateError([constructionError, cleanupError], "Local runtime construction or cleanup is unavailable.");
    }
    throw new Error("Local runtime construction is unavailable.", { cause: constructionError });
  }
}

async function closeLeasedSqliteOwner(writerLease: LinuxWriterLease, database: SqliteCapability, nativeDatabase: DatabaseSync): Promise<void> {
  await writerLease.stopAdmissionAndDrain();
  database.close(); // Sole original core owner. A failed ACK retains native and physical custody.
  if (nativeDatabase.isOpen) throw new Error("Local runtime native cleanup is unavailable.");
  await writerLease.release();
}

async function constructLeasedDevelopmentPrototype(options: Parameters<typeof createNodeDevelopmentPrototype>[0], fileCustody: LocalFileConstructionCustody): Promise<Awaited<ReturnType<typeof createNodeDevelopmentPrototype>>> {
  const { nativeDatabase, database, admission, hasher, identityPolicy, now, publicOrigin,
    clientDirectory, keyring, httpLimits, writerLease, localFileConfiguration } = options;
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  assertSqliteConnectionOwner(database, nativeDatabase);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const transport = createLoopbackLocalAuthTransport({ publicOrigin });
  const identity = await createInstalledLocalIdentity({ nativeDatabase, database, admission, hasher, policy: identityPolicy });
  // KDF construction awaited outside SQL ownership; reject a changed tuple now.
  assertSqliteConnectionOwner(database, nativeDatabase);
  assertInstallationAdmission(nativeDatabase, admission);
  const auth = createLocalAuthentication<NodeApplicationBindings>({ identity, transport, now });
  const transactionAdmission = createResearchWriteAdmission({ database, nativeDatabase, admission, writerLease,
    idleLifetimeMs: identityPolicy.idleLifetimeMs, sessionPredicate: auth.currentSessionPredicate });
  const configurationTransactionAdmission = createStorageConfigurationWriteAdmission({ database, nativeDatabase, admission, writerLease,
    idleLifetimeMs: identityPolicy.idleLifetimeMs, sessionPredicate: auth.currentSessionPredicate });
  const projectSubjectScope = Object.freeze({ authenticationFamily: "node-local" as const, installationContext: installation.installationId });
  const bindings = Object.freeze({ database });
  let active = true;
  let localFile: ReturnType<typeof createNodeLocalFileHost> | undefined;
  if (localFileConfiguration !== undefined) {
    fileCustody.hostAttempted = true;
    // Own the original returned host before the next async static-assets step.
    localFile = createNodeLocalFileHost({ configuration: localFileConfiguration, database, nativeDatabase,
      admission, writerLease, authentication: auth, stopApplicationAdmission: () => { active = false; } });
    fileCustody.host = localFile;
  }
  const localFileAdmissions = localFile?.admittedRoutes.map(route => ({ method: route.method,
    pattern: new RegExp(`^/api${route.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`) })) ?? [];
  const localFileMethodAdmitted = (method: string, path: string): boolean =>
    localFileAdmissions.some(route => route.method === method && route.pattern.test(path));
  const cache = createStorageConfigurationCacheControl<NodeApplicationBindings, NodeApplicationEnvironment["Variables"]>();
  const authenticate: MiddlewareHandler<NodeApplicationEnvironment> = (c, next) =>
    c.req.path === "/api/health" ? next() : auth.middleware(c, next);
  // Admission is method/path specific for partial business owners. Their other
  // routes cannot inherit support from a metadata or directory mount.
  const partialAdmission: MiddlewareHandler<NodeApplicationEnvironment> = async (c, next) => {
    if (["/api/health", "/api/ready", "/api/files/shadow/evidence/capabilities"].includes(c.req.path)
      || c.req.path === "/api/storage/configuration" || c.req.path.startsWith("/api/storage/configuration/")
      || businessMethodAdmitted(c.req.method, c.req.path) || localFileMethodAdmitted(c.req.method, c.req.path)) return next();
    return unavailable();
  };
  const admitCurrentActor = (request: Request) => async (actor: string): Promise<void> => {
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    // Re-read the actual persisted session and enabled account for every
    // service admission, retaining the captured exact ingress Request. The
    // actor is provenance, never an email/header-derived grant.
    await auth.admitActor(request, actor);
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  };
  const researchControlState = (message: string): void => {
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    try {
      const statement = nativeDatabase.prepare(`SELECT m.state,
        (SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL) AS writers,
        (SELECT mode FROM file_authority_control WHERE singleton=1) AS file_mode
        FROM system_recovery_maintenance m WHERE m.singleton=1`);
      statement.setReadBigInts(true); const row = statement.get();
      // This restricted composer supplies no maintenance or File writer. A
      // physically exclusive connection does not prove persisted controls are
      // idle, and an expired source lease is never proof of writer settlement.
      if (row?.state !== "open" || row.writers !== 0n || row.file_mode !== "legacy") throw new Error();
    } catch { throw new HTTPException(503, { message }); }
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  };
  const metadataState = (): void => researchControlState("Sample metadata writes are unavailable on this installation.");
  const metadataHandlers = createSampleMetadataHandlers<NodeApplicationBindings>(request => {
    const current = admitCurrentActor(request);
    const admit = async (actor: string): Promise<void> => {
      metadataState(); await current(actor); metadataState();
    };
    const service = (actor: string) => createSampleMetadataService({
      database: () => asStorageConfigurationSqlDatabase(database,
        () => transactionAdmission(request, actor, "Sample metadata writes are unavailable on this installation.")),
      admit, now, randomId: () => crypto.randomUUID() });
    const acknowledged = async <T>(actor: string, original: Promise<T>): Promise<T> => {
      const result = await original;
      // Accepted native writes are retained if this final current response
      // fence rejects. No rollback, replay or certain-delivery claim follows.
      await admit(actor); return result;
    };
    return {
      create: (value, actor) => acknowledged(actor, service(actor).create(value, actor)),
      update: (id, value, actor) => acknowledged(actor, service(actor).update(id, value, actor)),
      remove: (id, value, actor) => acknowledged(actor, service(actor).remove(id, value, actor)),
      restore: (id, value, actor) => acknowledged(actor, service(actor).restore(id, value, actor)),
    };
  });
  const sampleMetadata = new Hono<NodeApplicationEnvironment>();
  const metadataLimit = bodyLimit({ maxSize: MAX_NODE_SAMPLE_METADATA_BYTES,
    onError: c => c.json({ error: "Sample metadata is too large." }, 413) });
  // Capture BEFORE bodyLimit can replace c.req.raw with its bounded clone.
  sampleMetadata.post("/samples", metadataHandlers.captureIngressRequest, metadataLimit, metadataHandlers.create);
  sampleMetadata.patch("/samples/:id", metadataHandlers.captureIngressRequest, metadataLimit, metadataHandlers.update);
  sampleMetadata.delete("/samples/:id", metadataHandlers.captureIngressRequest, metadataLimit, metadataHandlers.remove);
  sampleMetadata.post("/samples/:id/restore", metadataHandlers.captureIngressRequest, metadataLimit, metadataHandlers.restore);
  const sampleReads = createSampleReadSurface<NodeApplicationBindings>(request => createSampleReadService({
    database: () => asStorageConfigurationSqlDatabase(database), admit: admitCurrentActor(request),
  }));
  const projectReads = createProjectReadSurface<NodeApplicationBindings>(request => createProjectReadService({
    database: () => asProjectReadDatabase(database), admit: admitCurrentActor(request),
  }), () => projectSubjectScope);
  const projectCreation = createProjectCreationHandlers<NodeApplicationBindings>(request => ({
    create: (value, actor) => {
      const current = admitCurrentActor(request), controls = () => researchControlState("Project creation is unavailable on this installation.");
      return createProjectCreationService({
        database: () => asProjectCreateDatabase(database,
          () => transactionAdmission(request, actor, "Project creation is unavailable on this installation.")),
        admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now,
      }).create(value, actor);
    },
  }), async (request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState("Project creation is unavailable on this installation.");
    controls(); await current(actor); controls();
    const subject = await projectCreationSubject(actor, projectSubjectScope);
    controls(); await current(actor); controls(); return subject;
  });
  const projectWrites = new Hono<NodeApplicationEnvironment>();
  const projectCreateLimit = bodyLimit({ maxSize: MAX_NODE_PROJECT_CREATE_BYTES,
    onError: c => c.json({ error: "Project creation request is too large." }, 413) });
  // Subject admission is before the first body read and domain SQL, retaining
  // the exact ingress Request through the later bounded raw-body clone.
  projectWrites.post("/projects", projectCreation.captureIngressRequest, projectCreation.admitCreationSubject,
    projectCreateLimit, projectCreation.create);
  const projectRename = createProjectRenameHandlers<NodeApplicationBindings>(request => ({
    rename: (id, value, actor) => {
      const current = admitCurrentActor(request), controls = () => researchControlState("Project rename is unavailable on this installation.");
      return createProjectRenameService({
        database: () => asProjectRenameDatabase(database,
          () => transactionAdmission(request, actor, "Project rename is unavailable on this installation.")),
        admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now,
      }).rename(id, value, actor);
    },
  }));
  const projectRenameLimit = bodyLimit({ maxSize: MAX_NODE_PROJECT_RENAME_BYTES,
    onError: c => c.json({ error: "Project update request is too large." }, 413) });
  // Mature PATCH uses its existing expectedRevision/operationId protocol. The
  // exact authenticated ingress is retained before bodyLimit substitutes raw.
  projectWrites.patch("/projects/:projectId", projectRename.captureIngressRequest, projectRenameLimit, projectRename.rename);
  const projectLifecycleMessage = "Project lifecycle updates are unavailable on this installation.";
  const projectLifecycle = createProjectLifecycleHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(projectLifecycleMessage);
    return createProjectLifecycleService({
      database: () => asProjectLifecycleDatabase(database, () => transactionAdmission(request, actor, projectLifecycleMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now,
    });
  });
  const projectLifecycleLimit = bodyLimit({ maxSize: MAX_NODE_PROJECT_LIFECYCLE_BYTES,
    onError: c => c.json({ error: "Project lifecycle request is too large." }, 413) });
  projectWrites.delete("/projects/:projectId", projectLifecycle.captureIngressRequest, projectLifecycleLimit, projectLifecycle.remove);
  projectWrites.post("/projects/:projectId/restore", projectLifecycle.captureIngressRequest, projectLifecycleLimit, projectLifecycle.restore);
  const itemMetadataMessage = "Project item metadata updates are unavailable on this installation.";
  const itemMetadata = createProjectItemMetadataHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(itemMetadataMessage);
    return createProjectItemMetadataService({
      database: () => asProjectItemMetadataDatabase(database, () => transactionAdmission(request, actor, itemMetadataMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now, registryId: () => crypto.randomUUID(),
    });
  });
  const itemMetadataLimit = bodyLimit({ maxSize: MAX_NODE_PROJECT_ITEM_METADATA_BYTES,
    onError: c => c.json({ error: "Project item metadata request is too large." }, 413) });
  projectWrites.post("/projects/:projectId/items/reference", itemMetadata.captureIngressRequest, itemMetadataLimit, itemMetadata.createReference);
  projectWrites.patch("/projects/:projectId/contents/:contentId/attachment", itemMetadata.captureIngressRequest, itemMetadataLimit, itemMetadata.updateAttachment);
  projectWrites.delete("/projects/:projectId/items/:itemId", itemMetadata.captureIngressRequest, itemMetadataLimit, itemMetadata.removeItem);
  const edgeMessage = "Project edge updates are unavailable on this installation.";
  const edges = createProjectEdgeHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(edgeMessage);
    return createProjectEdgeService({
      database: () => asProjectEdgeDatabase(database, () => transactionAdmission(request, actor, edgeMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now,
    });
  });
  const edgeLimit = bodyLimit({ maxSize: MAX_NODE_PROJECT_EDGE_BYTES,
    onError: c => c.json({ error: "Project edge request is too large." }, 413) });
  projectWrites.post("/projects/:projectId/edges", edges.captureIngressRequest, edgeLimit, edges.create);
  projectWrites.patch("/projects/:projectId/edges/:edgeId", edges.captureIngressRequest, edgeLimit, edges.update);
  projectWrites.delete("/projects/:projectId/edges/:edgeId", edges.captureIngressRequest, edgeLimit, edges.remove);
  projectWrites.post("/projects/:projectId/edges/:edgeId/restore", edges.captureIngressRequest, edgeLimit, edges.restore);
  const workspaceMessage = "Project workspace updates are unavailable on this installation.";
  const workspace = createProjectWorkspaceHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(workspaceMessage);
    return createProjectWorkspaceService({
      database: () => asProjectWorkspaceDatabase(database, () => transactionAdmission(request, actor, workspaceMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now,
    });
  });
  const workspaceLimit = bodyLimit({ maxSize: MAX_NODE_PROJECT_WORKSPACE_BYTES,
    onError: c => c.json({ error: "Project workspace request is too large." }, 413) });
  projectWrites.post("/projects/:projectId/items/markdown", workspace.captureIngressRequest, workspaceLimit, workspace.createMarkdown);
  projectWrites.patch("/projects/:projectId/contents/:contentId/markdown", workspace.captureIngressRequest, workspaceLimit, workspace.updateMarkdown);
  projectWrites.patch("/projects/:projectId/placements/:placementId", workspace.captureIngressRequest, workspaceLimit, workspace.updatePlacement);
  const templateReads = createTemplateReadSurface<NodeApplicationBindings>(request => createTemplateReadService({
    database: () => asStorageConfigurationSqlDatabase(database),
    authorityDatabase: () => asStorageConfigurationSqlDatabase(database), admit: admitCurrentActor(request),
  }));
  const definitionMessage = "Metrology template metadata is unavailable on this installation.";
  const definitions = createMetrologyDefinitionHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(definitionMessage);
    return createMetrologyDefinitionService({
      database: () => asMetrologyDefinitionDatabase(database, () => transactionAdmission(request, actor, definitionMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now, randomId: () => crypto.randomUUID(),
    });
  });
  const definitionWrites = new Hono<NodeApplicationEnvironment>();
  const definitionLimit = bodyLimit({ maxSize: MAX_NODE_METROLOGY_DEFINITION_BYTES,
    onError: c => c.json({ error: "Metrology template request is too large." }, 413) });
  definitionWrites.post("/metrology-templates", definitions.captureIngressRequest, definitionLimit, definitions.create);
  definitionWrites.patch("/metrology-templates/:id", definitions.captureIngressRequest, definitionLimit, definitions.update);
  definitionWrites.patch("/metrology-templates/:id/notes", definitions.captureIngressRequest, definitionLimit, definitions.notes);
  const lifecycleMessage = "Template lifecycle metadata is unavailable on this installation.";
  const lifecycle = createTemplateLifecycleHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(lifecycleMessage);
    return createTemplateLifecycleService({
      database: () => asTemplateLifecycleDatabase(database, () => transactionAdmission(request, actor, lifecycleMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); }, now,
    });
  });
  const lifecycleWrites = new Hono<NodeApplicationEnvironment>();
  const lifecycleLimit = bodyLimit({ maxSize: MAX_NODE_TEMPLATE_LIFECYCLE_BYTES,
    onError: c => c.json({ error: "Template lifecycle request is too large." }, 413) });
  lifecycleWrites.patch("/templates/:id", lifecycle.captureIngressRequest, lifecycleLimit, lifecycle.rename);
  lifecycleWrites.delete("/templates/:id", lifecycle.captureIngressRequest, lifecycleLimit, lifecycle.remove);
  lifecycleWrites.post("/templates/:id/restore", lifecycle.captureIngressRequest, lifecycleLimit, lifecycle.restore);
  const templateStepMessage = "Template step metadata is unavailable on this installation.";
  const templateStep = createTemplateStepDeleteHandlers<NodeApplicationBindings>((request, _bindings, actor) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(templateStepMessage);
    return createTemplateStepDeleteService({
      database: () => asTemplateStepDeleteDatabase(database, () => transactionAdmission(request, actor, templateStepMessage)),
      admit: async selectedActor => { controls(); await current(selectedActor); controls(); },
    });
  });
  lifecycleWrites.delete("/templates/:templateId/steps/:stepId", templateStep.captureIngressRequest, lifecycleLimit, templateStep.remove);
  const referenceHandlers = createReferenceReadHandlers<NodeApplicationBindings>(request => {
    const current = admitCurrentActor(request);
    const controls = () => researchControlState("Reference metadata reads are unavailable on this installation.");
    return createReferenceReadService({ database: () => asStorageConfigurationSqlDatabase(database),
      admit: async actor => { controls(); await current(actor); controls(); } });
  });
  const referenceReads = new Hono<NodeApplicationEnvironment>();
  const referenceLimit = bodyLimit({ maxSize: MAX_NODE_REFERENCE_INPUT_BYTES,
    onError: c => c.json({ error: "Reference metadata request is too large." }, 413) });
  // Each selector receives the exact transport-admitted Request, captured
  // before bodyLimit replaces its raw body. POST read methods still require
  // the genuine local Origin/CSRF policy; no media or registration is mounted.
  referenceReads.post("/references/resolve", referenceHandlers.captureIngressRequest, referenceLimit, referenceHandlers.resolve);
  referenceReads.post("/references/children", referenceHandlers.captureIngressRequest, referenceLimit, referenceHandlers.children);
  referenceReads.post("/references/search", referenceHandlers.captureIngressRequest, referenceLimit, referenceHandlers.search);
  const executionMessage = "Execution metadata is unavailable on this installation.";
  const executionAdmit = (request: Request) => {
    const current = admitCurrentActor(request), controls = () => researchControlState(executionMessage);
    return async (actor: string): Promise<void> => { controls(); await current(actor); controls(); };
  };
  const executionCapabilities = (request: Request, actor: string) => ({
    database: () => asStorageConfigurationSqlDatabase(database, () => transactionAdmission(request, actor, executionMessage)),
    admit: executionAdmit(request), now, randomId: () => crypto.randomUUID(),
  });
  const runTrash = createRunTrashHandlers<NodeApplicationBindings>(request => {
    const service = (actor: string) => createRunTrashService(executionCapabilities(request, actor));
    return {
      remove: (sampleId, runId, value, actor) => service(actor).remove(sampleId, runId, value, actor),
      restore: (sampleId, runId, value, actor) => service(actor).restore(sampleId, runId, value, actor),
    };
  });
  const metrology = createMetrologyWriteHandlers<NodeApplicationBindings>(request => {
    const service = (actor: string) => createMetrologyWriteService(executionCapabilities(request, actor));
    return {
      addEntry: (sampleId, runId, value, actor) => service(actor).addEntry(sampleId, runId, value, actor),
      startRun: (sampleId, value, actor) => service(actor).startRun(sampleId, value, actor),
    };
  });
  const confirmation = createStepConfirmationHandlers<NodeApplicationBindings>(request => ({
    confirm: (value, actor) => createStepConfirmationService({
      database: () => asStepConfirmationDatabase(database, () => transactionAdmission(request, actor, executionMessage)),
      admit: executionAdmit(request), now, randomId: () => crypto.randomUUID(),
    }).confirm(value, actor),
  }));
  const preview = createExecutionPreviewHandlers<NodeApplicationBindings>(request => createExecutionPreviewService({
    database: () => asStorageConfigurationSqlDatabase(database),
    authorityDatabase: () => asStorageConfigurationSqlDatabase(database.primary()), admit: executionAdmit(request),
  }));
  const finish = createRunFinishHandlers<NodeApplicationBindings>(request => ({
    finish: (sampleId, runId, value, actor) => createRunFinishService({
      database: () => asRunFinishDatabase(database, () => transactionAdmission(request, actor, executionMessage)),
      admit: executionAdmit(request), now, randomId: () => crypto.randomUUID(),
    }).finish(sampleId, runId, value, actor),
  }));
  const runPlan = createRunPlanHandlers<NodeApplicationBindings>(request => {
    const service = (actor: string) => createRunPlanService({
      database: () => asRunPlanDatabase(database, () => transactionAdmission(request, actor, executionMessage)),
      authorityDatabase: () => asStorageConfigurationSqlDatabase(database.primary()),
      admit: executionAdmit(request), now, randomId: () => crypto.randomUUID(),
    });
    return { start: (sampleId, value, actor) => service(actor).start(sampleId, value, actor),
      apply: (sampleId, runId, value, actor) => service(actor).apply(sampleId, runId, value, actor) };
  });
  const executionMetadata = new Hono<NodeApplicationEnvironment>(), executionVerification = new Hono<NodeApplicationEnvironment>();
  const executionLimit = bodyLimit({ maxSize: MAX_NODE_EXECUTION_METADATA_BYTES,
    onError: c => c.json({ error: "Execution metadata request is too large." }, 413) });
  // Each original transport Request is captured before bodyLimit replaces raw.
  // Existing authentication and physical app-promise ownership remain shared.
  executionMetadata.delete("/samples/:sampleId/runs/:runId", runTrash.captureIngressRequest, executionLimit, runTrash.remove);
  executionMetadata.post("/samples/:sampleId/runs/:runId/restore", runTrash.captureIngressRequest, executionLimit, runTrash.restore);
  executionMetadata.post("/samples/:sampleId/runs/:runId/metrology", metrology.captureIngressRequest, executionLimit, metrology.addEntry);
  executionMetadata.post("/samples/:sampleId/metrology-runs", metrology.captureIngressRequest, executionLimit, metrology.startRun);
  executionVerification.post("/run-steps/confirm", confirmation.captureIngressRequest, executionLimit, confirmation.confirm);
  executionMetadata.post("/samples/:id/runs/preview", preview.captureIngressRequest, executionLimit, preview.start);
  executionMetadata.post("/samples/:sampleId/runs/:runId/plan-update/preview", preview.captureIngressRequest, executionLimit, preview.planUpdate);
  executionMetadata.post("/samples/:sampleId/runs/:runId/finish", finish.captureIngressRequest, executionLimit, finish.finish);
  executionMetadata.post("/samples/:id/runs", runPlan.captureIngressRequest, executionLimit, runPlan.start);
  executionMetadata.post("/samples/:sampleId/runs/:runId/plan-update", runPlan.captureIngressRequest, executionLimit, runPlan.apply);
  const registry = (request: Request, actor: string) => createStorageConfigurationRegistry({
    database: () => asStorageConfigurationSqlDatabase(database,
      () => configurationTransactionAdmission(request, actor)),
    authorizeAdministrator: selectedActor => auth.authorize(request, selectedActor, "systemAdministrator"),
    keyring: keyring ?? (async () => { throw new Error("Storage credential encryption is unavailable"); }),
  });
  const configurationAcknowledged = async <T>(request: Request, actor: string, original: Promise<T>): Promise<T> => {
    const result = await original;
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    let allowed = false;
    try { allowed = await auth.authorize(request, actor, "systemAdministrator") === true; } catch { /* Fail closed. */ }
    if (!allowed) throw new AdministratorDenied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    // A late current-grant denial fences delivery, retaining any already accepted
    // immutable configuration revision/payload/audit. It never rolls it back.
    return result;
  };
  const configuration = createStorageConfigurationSurface<NodeApplicationBindings>({
    authorizeAdministrator: (request, _bindings, actor) => auth.authorize(request, actor, "systemAdministrator"),
    credentialEditingAvailable: async () => { try { return Boolean(keyring && await keyring()); } catch { return false; } },
    read: (_bindings, actor, request) => configurationAcknowledged(request, actor, registry(request, actor).readStorageConfiguration(actor)),
    save: (_bindings, input, actor, request) => configurationAcknowledged(request, actor, registry(request, actor).saveStorageCandidate(input, actor)),
    routeError: error => error instanceof StorageConfigurationError ? { status: error.status, message: error.message }
      : error instanceof AdministratorDenied ? { status: 403, message: error.message } : null,
  });
  const platform = createPlatformRoutes<NodeApplicationBindings>(current => asReadinessDatabase(current.database));
  const evidence = createFileEvidenceAccessRoutes<NodeApplicationBindings>((request, _bindings, actor) =>
    auth.authorize(request, actor, "fileEvidenceOperator"));
  const mountedLocalFile = localFile;
  const mounts: ApplicationRouteMounts<NodeApplicationEnvironment> = {
    maintenance: "unavailable", systemRecovery: "unavailable", storageConfiguration: app => { app.route("/", configuration); },
    platform: app => { app.route("/", platform); }, storageSettings: "unavailable",
    fileAuthority: mountedLocalFile ? application => { application.route("/", mountedLocalFile.routes); } : "unavailable",
    migration: mountedLocalFile?.jobRoutes ? application => { application.route("/", mountedLocalFile.jobRoutes!); } : "unavailable",
    package: mountedLocalFile?.packageRoutes ? application => { application.route("/", mountedLocalFile.packageRoutes!); } : "unavailable", commentSubmission: "unavailable", projectFoundation: "unavailable",
    exportSnapshot: "unavailable", shadow: "unavailable", fileEvidenceAccess: app => { app.route("/", evidence); },
    shadowAdjudication: "unavailable", project: app => { app.route("/", projectReads); app.route("/", projectWrites); }, reference: app => { app.route("/", referenceReads); },
    sample: app => { app.route("/", sampleReads); app.route("/", sampleMetadata); },
    execution: app => { app.route("/", executionMetadata); }, legacyEvidence: "unavailable",
    executionVerification: app => { app.route("/", executionVerification); }, attachment: "unavailable",
    exportBlob: "unavailable", fabublox: "unavailable", processDefinition: app => { app.route("/", templateReads); app.route("/", definitionWrites); app.route("/", lifecycleWrites); },
  };
  const app = composeApiApplication<NodeApplicationEnvironment>({
    handleError: createApiErrorHandler<NodeApplicationEnvironment>(),
    storageSettingsCacheControl: cache, storageConfigurationCacheControl: cache, authenticate,
    sourceMaintenanceAdmission: partialAdmission, fileAuthorityExecutionAdmission: partialAdmission,
    publicAuthenticationRoutes: application => { application.route("/auth", auth.routes); }, routeMounts: mounts,
  });
  app.all("*", () => unavailable());
  // Dropped only after original operations drain, then the actual connection
  // closes. Old middleware/query capabilities cannot service a restarted owner.
  let owners: { app: typeof app; bindings: typeof bindings } | undefined = { app, bindings };
  const pendingApi = new Set<Promise<Response>>();
  const api: FetchHandler = async request => {
    if (!active) return unavailable();
    // The HTTP transport may stop owning a timed-out request before the actual
    // identity/KDF/service operation settles. Retain that original writer owner.
    const operation = writerLease.withWriter(() => {
      const current = owners;
      if (!current) return unavailable();
      // CREATE the original promise under physical ownership. Wrapping a
      // previously started fetch would permit writes before tracked admission.
      return Promise.resolve(current.app.fetch(request, current.bindings));
    });
    pendingApi.add(operation);
    try { return await operation; }
    finally { pendingApi.delete(operation); }
  };
  const handler = await createStaticAssetsHandler({ directory: clientDirectory, api, isSpaPath: isNodeClientSpaPath });
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  fileCustody.transportAttempted = true;
  const server = createNodeHttpServer(request => active ? handler(request) : unavailable(), {
    ...httpLimits, publicOrigin,
    requestAdmission(request, incoming, actualServer) {
      try { transport.admit(request, incoming, actualServer); }
      catch { return Response.json({ error: "Request admission is required." },
        { status: 403, headers: { "Cache-Control": "private, no-store" } }); }
    },
  });
  fileCustody.server = server;
  localFile?.startJobsOnListening(server);
  let closing: Promise<void> | undefined;
  const prototype: Awaited<ReturnType<typeof createNodeDevelopmentPrototype>> = Object.freeze({ server,
    dispatchFileJobsOnce() {
      if (!active) return Promise.reject(new Error("Local runtime admission is closed"));
      return localFile ? localFile.dispatchJobsOnce() : Promise.resolve({ jobId: null, outcome: "disabled" });
    },
    unsupportedRouteOwners: Object.freeze([...BEFORE_FILE_AUTHORITY_ROUTE_OWNERS, ...AFTER_FILE_AUTHORITY_ROUTE_OWNERS]
      .filter(name => mounts[name] === "unavailable")),
    close() {
      if (closing) return closing;
      active = false;
      localFile?.stopAdmission();
      const physicalDrain = writerLease.stopAdmissionAndDrain();
      void physicalDrain.catch(() => {}); // Preserve rejection for finally without an earlier unhandled promise.
      closing = (async () => {
        // A Response is not the lifetime of its body. Drain the exact issued
        // HTTP owner as well as original application/KDF and physical writers.
        // A failed original disposer retains this same app/native/lease tuple.
        const results = await Promise.allSettled([stopNodeHttpServerAndDrain(server),
          Promise.allSettled([...pendingApi]), physicalDrain,
          ...(localFile ? [localFile.drainAfterTransport(server)] : [])]);
        const failures = results.flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
        if (failures.length) throw new AggregateError(failures, "Local runtime original shutdown drain failed.");
        await closeLeasedSqliteOwner(writerLease, database, nativeDatabase);
        owners = undefined; // Drop original capabilities only after native AND physical close ACK.
      })().catch(error => {
        failedDevelopmentOwners.add({ prototype, closing, physicalDrain, owners, pendingApi, localFile, fileCustody, writerLease, database, nativeDatabase, error });
        throw error;
      }); // Retain the exact first close promise, including its rejection; no retry.
      return closing;
    },
  });
  return prototype;
}
