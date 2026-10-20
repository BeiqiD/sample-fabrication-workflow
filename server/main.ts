import { loadNodeRuntimeConfiguration } from './node-runtime-config';
import { NodeRuntimeError } from './node-runtime';
import { parseNodeRuntimeCommand } from './node-runtime-command';
import { startSelectedNodeDevelopmentRuntime, type SelectedNodeDevelopmentRuntime } from './node-runtime-profile';

const USAGE = 'Usage: node main.mjs --config <canonical-private-config> [--filesystem-root-owner-uid UID] [--runtime-profile v28-metadata|v28-fabublox|v28-recovery|v28-workflow]\nRestricted local development runtime only; exact numeric loopback HTTP origin and existing current installation required.\nOffline identities: use identity-cli.cjs bootstrap, restore-administrator or reset-password while this server is stopped; password comes only from stdin or a hidden terminal.\n';

async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === '--help') { process.stdout.write(USAGE); return; }
  const selected = parseNodeRuntimeCommand(process.argv.slice(2));
  const config = loadNodeRuntimeConfiguration(selected.path, {
    ...(selected.filesystemRootOwnerUid === undefined ? {} : { filesystemRootOwnerUid: selected.filesystemRootOwnerUid }),
    ...(selected.profile === undefined ? {} : { runtimeProfile: selected.profile }),
  });
  const shutdown = new AbortController();
  let runtime: SelectedNodeDevelopmentRuntime | undefined, resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => { resolveStop = resolve; });
  let listenerFailed = false;
  const stop = () => { shutdown.abort(); resolveStop(); };
  const listenerError = () => { listenerFailed = true; stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    // A startup signal records cancellation; it never releases a lease while
    // an original constructor KDF/native operation remains unsettled.
    runtime = await startSelectedNodeDevelopmentRuntime(config, selected.profile, { signal: shutdown.signal });
    runtime.server.on('error', listenerError);
    if (!shutdown.signal.aborted) {
      if (selected.profile === undefined) process.stdout.write('Restricted local development runtime started.\n');
      else process.stdout.write(`Restricted ${selected.profile} development runtime started.\n${JSON.stringify(runtime.capabilities)}\n`);
    }
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
