// Actual independent-process fixture. No account passwords or session tokens
// are passed in argv/environment or written to stdout; IPC stays test-owned.
import { DatabaseSync } from 'node:sqlite';
import { createSqliteCapability } from '../sqlite';
import { createPasswordHasher } from './passwords';
import { createPrototypeLocalIdentity } from './identity';
import { inspectPrototypeIdentityCatalog } from './identity-catalog';
const database = createSqliteCapability(new DatabaseSync(process.argv[2]!, { allowExtension: false }));
const service = await createPrototypeLocalIdentity({ database, admission: await inspectPrototypeIdentityCatalog(database), hasher: createPasswordHasher(),
  policy: { absoluteLifetimeMs: 10000, idleLifetimeMs: 1000, loginWindowMs: 5000, loginAttempts: 5, throttleBuckets: 100 } });
process.on('message', async (input: { command: 'bootstrap' | 'rotate' | 'restore'; token?: string; principalId?: string }) => {
  try {
    if (input.command === 'bootstrap') { await service.offline({ assertHeld() {} }).bootstrap({ username: 'operator', password: 'child test password', now: 100 }); process.send?.({ kind: 'result', ok: true }); }
    else if (input.command === 'restore') { await service.offline({ assertHeld() {} }).restoreAdministrator({ principalId: input.principalId!, password: 'destination child password', now: 300 }); process.send?.({ kind: 'result', ok: true }); }
    else { const rotated = await service.rotate(input.token, 400); process.send?.({ kind: 'result', ok: !!rotated, token: rotated?.token }); }
  } catch (error) { process.send?.({ kind: 'result', ok: false, code: error && typeof error === 'object' && 'code' in error ? error.code : 'unexpected_error' }); }
  finally { database.close(); process.disconnect(); }
});
process.send?.({ kind: 'ready' });
