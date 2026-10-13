import { NodeRuntimeError, startNodeDevelopmentRuntime, type RunningNodeDevelopmentRuntime } from './node-runtime';
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from './node-runtime-config';
import type { NodeRuntimeProfile } from './node-runtime-command';
import type { GroupV28Capabilities } from './collaboration/group-v28-capabilities';

export type SelectedNodeDevelopmentRuntime = Pick<RunningNodeDevelopmentRuntime, 'server' | 'close'> & {
  readonly capabilities?: Readonly<GroupV28Capabilities>;
};

/** Keep V26 startup and its options unchanged unless a closed V28 profile is
 * selected. The V28 owner rechecks the genuine config, exact existing catalog,
 * Group enforcement and its same original Native/physical parents. */
export async function startSelectedNodeDevelopmentRuntime(configuration: LoadedNodeRuntimeConfiguration,
  profile: NodeRuntimeProfile | undefined, options: { signal?: AbortSignal } = {}): Promise<SelectedNodeDevelopmentRuntime> {
  assertNodeRuntimeConfigurationForProfile(configuration, profile);
  if (profile === undefined) return startNodeDevelopmentRuntime(configuration, options);
  const signal = options?.signal;
  if (profile !== 'v28-metadata' && profile !== 'v28-fabublox'
    || !options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'signal')
    || signal !== undefined && !(signal instanceof AbortSignal)) throw new NodeRuntimeError();
  // Default V26 does not evaluate this additional runtime graph.
  const { startGroupV28RuntimeCandidate } = await import('./collaboration/group-v28-runtime-candidate');
  return startGroupV28RuntimeCandidate(configuration, { signal,
    ...(profile === 'v28-fabublox' ? { fabubloxConfiguration: configuration } : {}) });
}
