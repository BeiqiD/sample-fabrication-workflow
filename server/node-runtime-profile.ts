import { NodeRuntimeError, startNodeDevelopmentRuntime, type RunningNodeDevelopmentRuntime } from './node-runtime';
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from './node-runtime-config';
import type { NodeRuntimeProfile } from './node-runtime-command';
import type { GroupV28Capabilities } from './collaboration/group-v28-capabilities';
import type { NodeV28WorkflowApplication } from './workflow/node-v28-workflow-application';
import type { NodeSystemRecoveryV28Application } from './recovery/node-system-recovery-v28-application';

type ExistingSelectedNodeDevelopmentRuntime = Pick<RunningNodeDevelopmentRuntime, 'server' | 'close'> & {
  readonly capabilities?: Readonly<GroupV28Capabilities>;
};
type SelectedNodeRecoveryRuntime = Pick<RunningNodeDevelopmentRuntime, 'server' | 'close'> & {
  readonly capabilities: NodeSystemRecoveryV28Application['surfaceCapabilities'];
  dispatchRecoveryJobsOnce(): ReturnType<NodeSystemRecoveryV28Application['dispatchRecoveryJobsOnce']>;
};
type SelectedNodeWorkflowRuntime = Pick<RunningNodeDevelopmentRuntime, 'server' | 'close'> & {
  readonly capabilities: NodeV28WorkflowApplication['capabilities'];
  dispatchJobsOnce(): ReturnType<NodeV28WorkflowApplication['dispatchJobsOnce']>;
};
export type SelectedNodeDevelopmentRuntime = ExistingSelectedNodeDevelopmentRuntime | SelectedNodeRecoveryRuntime | SelectedNodeWorkflowRuntime;

/** Keep V26 startup and its options unchanged unless a closed V28 profile is
 * selected. The V28 owner rechecks the genuine config, exact existing catalog,
 * Group enforcement and its same original Native/physical parents. */
export function startSelectedNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  profile: 'v28-metadata' | 'v28-fabublox' | undefined, options?: { signal?: AbortSignal }): Promise<ExistingSelectedNodeDevelopmentRuntime>;
export function startSelectedNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  profile: 'v28-recovery', options?: { signal?: AbortSignal }): Promise<SelectedNodeRecoveryRuntime>;
export function startSelectedNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  profile: 'v28-workflow', options?: { signal?: AbortSignal }): Promise<SelectedNodeWorkflowRuntime>;
export function startSelectedNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  profile: NodeRuntimeProfile | undefined, options?: { signal?: AbortSignal }): Promise<SelectedNodeDevelopmentRuntime>;
export async function startSelectedNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  profile: NodeRuntimeProfile | undefined, options: { signal?: AbortSignal } = {}): Promise<SelectedNodeDevelopmentRuntime> {
  assertNodeRuntimeConfigurationForProfile(configuration, profile);
  if (profile === undefined) return startNodeDevelopmentRuntime(configuration, options);
  const signal = options?.signal;
  if (profile !== 'v28-metadata' && profile !== 'v28-fabublox' && profile !== 'v28-recovery' && profile !== 'v28-workflow'
    || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'signal')
    || signal !== undefined && !(signal instanceof AbortSignal)) throw new NodeRuntimeError();
  // Default V26 does not evaluate this additional runtime graph.
  if (profile === 'v28-workflow') {
    const { startV28WorkflowRuntime } = await import('./workflow/node-v28-workflow-runtime');
    return startV28WorkflowRuntime(configuration, { signal });
  }
  if (profile === 'v28-recovery') {
    const { startNodeSystemRecoveryV28Runtime } = await import('./recovery/node-system-recovery-v28-runtime');
    return startNodeSystemRecoveryV28Runtime(configuration, { signal });
  }
  const { startGroupV28RuntimeCandidate } = await import('./collaboration/group-v28-runtime-candidate');
  return startGroupV28RuntimeCandidate(configuration, { signal,
    ...(profile === 'v28-fabublox' ? { fabubloxConfiguration: configuration } : {}) });
}
