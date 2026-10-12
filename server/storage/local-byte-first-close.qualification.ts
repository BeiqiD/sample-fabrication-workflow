import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const modes = ["data-close-before", "data-close-after", "data-work-and-close", "metadata-work-and-close",
  "constructor-close", "read-close-after", "source-cancel", "readonly-write", "rename-after",
  "verifier-dispose", "verifier-constructor", "outer-write-cancel"] as const;
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
    const directory = await mkdtemp("/workspace/.local-byte-fault-bundle-");
    modulePath = join(directory, "original-native-fault-control.mjs");
    await build({ entryPoints: [resolve("server/storage/local-byte-first-close.process-fixture.ts")], outfile: modulePath,
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
    const root = await mkdtemp("/workspace/.local-byte-fault-root-");
    await mkdir(join(root, "objects"), { mode: 0o700 }); await mkdir(join(root, "staging"), { mode: 0o700 });
    const namespace = { volumeId: randomUUID(), rootId: randomUUID(), profileId: randomUUID(), namespaceRevision: 1 };
    await writeFile(join(root, "namespace.json"), JSON.stringify({ format: "local-byte-namespace-v1", namespace }), { flag: "wx", mode: 0o600 });
    const child = spawn(process.execPath, [modulePath, root, JSON.stringify(namespace), mode], { stdio: ["ignore", "pipe", "pipe"] });
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
    expect(outcome).toEqual({ code: 0, signal: null }); expect(stderr).toBe("");
    expect(stdout.length).toBeLessThan(16_384);
    const observation = JSON.parse(stdout) as Record<string, unknown>;
    expect(observation).toMatchObject({ version: 1, mode, assertionsComplete: true, appNativeLeaseAckClaimed: false,
      existingFoundationCasesRepeated: 0 });
    return observation;
  })();
  owner.setup = original;
  void original.catch(() => undefined);
  return original;
}
describe("actual Local byte original cleanup fault controls", () => {
  it.each(modes)("preserves the actual original %s outcome and terminal-process boundary", async mode => {
    const observation = await control(mode);
    if (["readonly-write", "rename-after"].includes(mode)) expect(observation.backendNormalCloseAck).toBe(true);
    else if (["verifier-dispose", "verifier-constructor", "outer-write-cancel"].includes(mode)) expect(observation.failedOriginalOwnerRetained).toBe(false);
    else expect(observation).toMatchObject({ backendNormalCloseAck: false, failedOriginalOwnerRetained: true, terminalProcessClosureOnly: true });
  }, 20_000);
});
