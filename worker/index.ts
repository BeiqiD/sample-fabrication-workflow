import { Hono } from "hono";
import { routes as commentSubmissionRoutes } from "./comment-submission-routes";
import { routes as projectRoutes } from "./project-routes";
import { routes as projectFoundationRoutes } from "./project-foundation-routes";
import { snapshotRoutes as exportSnapshotRoutes, blobRoutes as exportBlobRoutes } from "./export-routes";
import { routes as referenceRoutes } from "./reference-routes";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import type { Env } from "./types";
import { routes as sampleRoutes } from "./samples/routes";
import { routes as executionRoutes, verificationRoutes as executionVerificationRoutes } from "./execution/routes";
import { routes as processDefinitionRoutes } from "./process-definition/routes";
import { routes as legacyEvidenceRoutes } from "./evidence/legacy-routes";
import { routes as fabubloxRoutes } from "./imports/fabublox-routes";
import { routes as attachmentRoutes } from "./blob-lifecycle/attachment-routes";
import { authenticateApiRequest, handleError, routes as platformRoutes } from "./platform/http";
import { shadowRoutes } from "./files/shadow-routes";
import { fileEvidenceAccessRoutes } from "./files/evidence-operator";
import { shadowAdjudicationRoutes } from "./files/shadow-adjudication-routes";
import { storageConfigurationCacheControl, storageConfigurationRoutes } from "./storage/configuration-routes";
import { storageSettingsCacheControl, storageSettingsRoutes } from "./storage/routes";
import { fileAuthorityExecutionAdmission } from "./files/authority-execution";
import { fileAuthorityRoutes } from "./files/authority-activation";

const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>().basePath("/api");

app.onError(handleError);
app.use("/settings/storage", storageSettingsCacheControl);
app.use("/storage/configuration", storageConfigurationCacheControl);
app.use("/storage/configuration/*", storageConfigurationCacheControl);
app.use("*", authenticateApiRequest);
// Only these authenticated, separately authorized configuration handlers run
// before the recovered File execution gate. Other routes keep their admission.
app.route("/", storageConfigurationRoutes);
app.use("*", fileAuthorityExecutionAdmission);
app.route("/", platformRoutes);
app.route("/", storageSettingsRoutes);
app.route("/", fileAuthorityRoutes);

app.route("/", commentSubmissionRoutes);
app.route("/", projectFoundationRoutes);
app.route("/", exportSnapshotRoutes);
app.route("/", shadowRoutes);
app.route("/", fileEvidenceAccessRoutes);
app.route("/", shadowAdjudicationRoutes);
app.route("/", projectRoutes);
app.route("/", referenceRoutes);
app.route("/", sampleRoutes);

app.route("/", executionRoutes);

app.route("/", legacyEvidenceRoutes);

app.route("/", executionVerificationRoutes);

app.route("/", attachmentRoutes);

app.route("/", exportBlobRoutes);

app.route("/", fabubloxRoutes);

app.route("/", processDefinitionRoutes);

export default {
  fetch: (request: Request, env: Env, executionContext: ExecutionContext) => app.fetch(request, env, executionContext),
  scheduled: (_event: ScheduledController, env: Env, executionContext: ExecutionContext) => {
    executionContext.waitUntil(cleanupCommentUploads(env));
  },
} satisfies ExportedHandler<Env>;
