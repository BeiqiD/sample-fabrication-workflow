import { createWorkerApplication } from "./application";
import { cleanupCommentUploads } from "./comment-upload-cleanup";
import { dispatchResearchAndFileJobs } from "./packages/jobs/scheduled-runtime";
import { runSourceScheduledWriters } from "./recovery/maintenance";
import { dispatchSystemRecoveryJobs } from "./recovery/service";
import type { Env } from "./types";

const app = createWorkerApplication();

export default {
  fetch: (request: Request, env: Env, executionContext: ExecutionContext) => app.fetch(request, env, executionContext),
  scheduled: (event: ScheduledController, env: Env, executionContext: ExecutionContext) => {
    executionContext.waitUntil(runSourceScheduledWriters(env, event.scheduledTime, async () => {
      // Drain both writers before releasing their lease, even if one fails.
      const outcomes = await Promise.allSettled([
        cleanupCommentUploads(env), dispatchResearchAndFileJobs(env, event.scheduledTime),
      ]);
      const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    }));
    executionContext.waitUntil(dispatchSystemRecoveryJobs(env));
  },
} satisfies ExportedHandler<Env>;
