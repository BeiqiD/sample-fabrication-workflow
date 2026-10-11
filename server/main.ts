import { loadNodeRuntimeConfiguration } from './node-runtime-config';
import { NodeRuntimeError, startNodeDevelopmentRuntime, type RunningNodeDevelopmentRuntime } from './node-runtime';

const USAGE = 'Usage: node main.mjs --config <canonical-private-config> [--filesystem-root-owner-uid UID]\nRestricted local development runtime only; exact numeric loopback HTTP origin and existing current installation required.\nOffline identities: use identity-cli.cjs bootstrap, restore-administrator or reset-password while this server is stopped; password comes only from stdin or a hidden terminal.\n';
function command(argv: readonly string[]): { path: string; filesystemRootOwnerUid?: number } {
  if (!Array.isArray(argv) || ![2, 4].includes(argv.length) || argv.some(value => typeof value !== 'string' || value.length > 4000)) throw new NodeRuntimeError();
  const fields = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]!; if (!['--config', '--filesystem-root-owner-uid'].includes(name) || fields.has(name)) throw new NodeRuntimeError();
    fields.set(name, argv[index + 1]!);
  }
  const path = fields.get('--config'); if (!path) throw new NodeRuntimeError();
  const raw = fields.get('--filesystem-root-owner-uid');
  if (raw === undefined) return { path };
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(raw) || Number(raw) > 0xffff_ffff) throw new NodeRuntimeError();
  return { path, filesystemRootOwnerUid: Number(raw) };
}

async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') { process.stdout.write(USAGE); return; }
  const selected = command(process.argv.slice(2));
  const config = loadNodeRuntimeConfiguration(selected.path, selected.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: selected.filesystemRootOwnerUid });
  const shutdown = new AbortController();
  let runtime: RunningNodeDevelopmentRuntime | undefined, resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { resolveStop = resolve; });
  let listenerFailed = false;
  const stop = () => { shutdown.abort(); resolveStop(); };
  const listenerError = () => { listenerFailed = true; stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    // A startup signal records cancellation; it never releases a lease while
    // an original constructor KDF/native operation remains unsettled.
    runtime = await startNodeDevelopmentRuntime(config, { signal: shutdown.signal });
    runtime.server.on('error', listenerError);
    if (!shutdown.signal.aborted) process.stdout.write('Restricted local development runtime started.\n');
    await stopRequested;
    await runtime.close();
    if (listenerFailed) throw new NodeRuntimeError();
  } finally {
    // Original work, actual native close and physical release precede handler
    // disposal. A failed close remains a failure, never a success shutdown ACK.
    try { await runtime?.close(); }
    finally {
      runtime?.server.removeListener('error', listenerError);
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    }
  }
}
void main().catch(() => {
  process.stderr.write('Local development runtime unavailable.\n'); process.exitCode = 1;
});
