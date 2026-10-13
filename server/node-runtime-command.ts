import { NodeRuntimeError } from './node-runtime';

export type NodeRuntimeProfile = 'v28-metadata' | 'v28-fabublox' | 'v28-recovery';
export interface NodeRuntimeCommand {
  readonly path: string;
  readonly filesystemRootOwnerUid?: number;
  readonly profile?: NodeRuntimeProfile;
}

/** An absent selector retains the original V26 entry. Named profiles are
 * explicit surface selections, never installation, migration or authority. */
export function parseNodeRuntimeCommand(argv: readonly string[]): NodeRuntimeCommand {
  if (!Array.isArray(argv) || ![2, 4, 6].includes(argv.length)
    || argv.some(value => typeof value !== 'string' || value.length > 4000)) throw new NodeRuntimeError();
  const fields = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]!;
    if (!['--config', '--filesystem-root-owner-uid', '--runtime-profile'].includes(name) || fields.has(name)) throw new NodeRuntimeError();
    fields.set(name, argv[index + 1]!);
  }
  const path = fields.get('--config'); if (!path) throw new NodeRuntimeError();
  const raw = fields.get('--filesystem-root-owner-uid');
  if (raw !== undefined && (!/^(?:0|[1-9][0-9]{0,9})$/.test(raw) || Number(raw) > 0xffff_ffff)) throw new NodeRuntimeError();
  const profile = fields.get('--runtime-profile');
  if (profile !== undefined && profile !== 'v28-metadata' && profile !== 'v28-fabublox' && profile !== 'v28-recovery') throw new NodeRuntimeError();
  return { path, ...(raw === undefined ? {} : { filesystemRootOwnerUid: Number(raw) }), ...(profile === undefined ? {} : { profile }) };
}
