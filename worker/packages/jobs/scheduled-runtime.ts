import type { Env } from "../../types";
import { dispatchFileJobs } from "../../files/jobs/worker-runtime";
import { dispatchPackageJobs } from "./worker-runtime";

/** The existing independent 120-second invocation performs one durable action.
 * Alternating first choice prevents either queue from monopolizing the runner;
 * an idle queue can yield its slot without running two actions together. */
export async function dispatchResearchAndFileJobs(env: Env, scheduledTime: number) {
  const packageFirst = Math.floor(scheduledTime / 120_000) % 2 === 0;
  const first = packageFirst ? dispatchPackageJobs : dispatchFileJobs;
  const second = packageFirst ? dispatchFileJobs : dispatchPackageJobs;
  const result = await first(env);
  return ["idle","unsupported"].includes(result.outcome) ? second(env) : result;
}
