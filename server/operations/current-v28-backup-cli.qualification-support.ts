import { afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

interface CliOwner {
  child?: ChildProcess; constructionAttempted: boolean; constructionFailure?: unknown;
  originalClose?: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
}
const cliOwners = new Set<CliOwner>();
afterEach(() => {
  if (cliOwners.size) throw new AggregateError([...cliOwners].map(owner => owner.originalClose ?? owner.constructionFailure),
    'Original bundled restoration ownership remains unproven');
});
export async function runCurrentCli(distribution: string, entry: 'installation-cli.cjs' | 'restore-v28-cli.cjs', argv: readonly string[]) {
  const owner: CliOwner = { constructionAttempted: false }; cliOwners.add(owner);
  owner.constructionAttempted = true;
  try {
    owner.child = spawn(process.execPath, [join(distribution, 'server', entry), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { owner.constructionFailure = error; throw error; }
  const child = owner.child;
  owner.originalClose = new Promise((done, fail) => {
    let stdout = '', stderr = '', outputBytes = 0, outputFailure: Error | undefined, spawnError: unknown;
    child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
    const capture = (value: string, standardOutput: boolean) => {
      outputBytes += Buffer.byteLength(value);
      if (outputBytes > 16 * 1024) { outputFailure ??= new Error('Bundled CLI diagnostic budget exceeded'); return; }
      if (standardOutput) stdout += value; else stderr += value;
    };
    child.stdout!.on('data', (value: string) => { capture(value, true); });
    child.stderr!.on('data', (value: string) => { capture(value, false); });
    child.once('error', error => { spawnError = error; });
    // The same original close event settles output/error observations; no
    // signal, timer, error event or process-looking flag substitutes for it.
    child.once('close', (code, signal) => {
      cliOwners.delete(owner);
      if (spawnError || outputFailure) fail(spawnError ?? outputFailure);
      else done({ code, signal, stdout, stderr });
    });
  });
  owner.originalClose.then(() => undefined, () => undefined);
  return await owner.originalClose;
}

