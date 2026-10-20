import type { Env } from "../../types";
import { dispatchFileJobs } from "../../files/jobs/worker-runtime";
import { dispatchPackageJobs } from "./worker-runtime";
import { claimResearchSchedulerTurn } from "./scheduler-turn";

/** One advancing Package/Migration action per independently admitted invocation.
 * The persisted turn is independent of cron frequency, missed slots and restart.
 * An idle/unsupported queue may yield; no second busy action runs in this event.
 * This entry point does not install or verify a deployment's trigger/cadence. */
export async function dispatchResearchAndFileJobs(env: Env, _scheduledTime: number) {
  const turn = await claimResearchSchedulerTurn(env.DB);
  if (turn.outcome === "migration_only") return dispatchFileJobs(env);
  if (turn.outcome !== "selected") return { jobId: null, outcome: turn.outcome };
  const first = turn.queue === "package" ? dispatchPackageJobs : dispatchFileJobs;
  const second = turn.queue === "package" ? dispatchFileJobs : dispatchPackageJobs;
  const result = await first(env, turn.incarnation);
  return ["idle", "unsupported"].includes(result.outcome) ? second(env, turn.incarnation) : result;
}
