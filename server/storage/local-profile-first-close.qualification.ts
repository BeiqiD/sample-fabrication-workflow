import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const modes = ["profile-constructor-close", "profile-data-close", "profile-body-cancel", "profile-current-and-cancel", "profile-normal-close"] as const;
interface OriginalOwner {
  setup?: Promise<Record<string, unknown>>;
  child?: ChildProcess;
  close?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  spawnError?: unknown;
}
const owners = new Set<OriginalOwner>();
let modulePath: string, originalBuild: Promise<unknown>;
beforeAll(async () => {
  originalBuild = (async () => {
    const directory = await mkdtemp("/workspace/.local-profile-fault-bundle-");
    modulePath = join(directory, "original-native-fault-control.mjs");
    await build({ entryPoints: [resolve("server/storage/local-profile-first-close.process-fixture.ts")], outfile: modulePath,
      bundle: true, platform: "node", format: "esm", sourcemap: false });
  })();
  await originalBuild;
}, 20_000);
afterAll(async () => {
  const failures: unknown[] = [];
  if (originalBuild) try { await originalBuild; } catch (error) { failures.push(error); }
  for (const owner of owners) {
    // Await the complete original setup before inspecting its actual child.
    // No close-event rejection, timeout or failed assertion authorizes a kill,
    // retry, parent release or graceful application close claim.
    if (owner.setup) try { await owner.setup; } catch (error) { failures.push(error); }
    if (owner.close) try { await owner.close; } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Original Local fault controls did not all settle");
});
function control(mode: typeof modes[number]): Promise<Record<string, unknown>> {
  const owner: OriginalOwner = {}; owners.add(owner);
  const original = (async () => {
    const root = await mkdtemp("/workspace/.local-profile-fault-root-");
    const child = spawn(process.execPath, [modulePath, root, mode], { stdio: ["ignore", "pipe", "pipe"] });
    owner.child = child;
    let stdout = "", stderr = "";
    child.stdout!.on("data", data => { stdout += String(data); });
    child.stderr!.on("data", data => { stderr += String(data); });
    child.on("error", error => { owner.spawnError = error; });
    const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
      child.once("close", (code, signal) => done({ code, signal }));
    });
    owner.close = close;
    const outcome = await close;
    if (owner.spawnError) throw owner.spawnError;
    expect(stdout.length).toBeLessThan(16_384); expect(stderr.length).toBeLessThan(32_768);
    await writeFile(join(root, "original-child.stdout"), stdout, { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "original-child.stderr"), stderr, { flag: "wx", mode: 0o600 });
    expect(outcome, `Original child evidence retained at ${root}`).toEqual({ code: 0, signal: null });
    const observation = JSON.parse(stdout) as Record<string, unknown>;
    expect(observation).toMatchObject({ version: 1, mode, assertionsComplete: true, appComposerAckClaimed: false });
    return observation;
  })();
  owner.setup = original;
  void original.catch(() => undefined);
  return original;
}
describe("genuine installed Local profile Native and lease cleanup negatives", () => {
  it.each(modes)("retains the original %s owner before Native or physical release", async mode => {
    const observation = await control(mode);
    if (mode === "profile-normal-close") {
      expect(observation).toMatchObject({ nativeCloseCalls: 1, leaseReleaseCalls: 1, parentByteCloseCalls: [1, 1, 1],
        actualNativeStillOpen: false, genuineKernelWriterCompetition: "fresh-acquired-and-released",
        originalPhysicalOwnerRetained: false, normalProfileNativeLeaseAck: true, terminalKernelSettlementOnly: false });
      return;
    }
    expect(observation).toMatchObject({ nativeCloseCalls: 0, leaseReleaseCalls: 0, originalByteCloseCalls: 1,
      parentByteCloseCalls: [0, 0, 0], actualNativeStillOpen: true, genuineKernelWriterCompetition: "busy",
      originalPhysicalOwnerRetained: true, normalProfileNativeLeaseAck: false, terminalKernelSettlementOnly: true,
      appComposerAckClaimed: false });
  }, 20_000);
});
