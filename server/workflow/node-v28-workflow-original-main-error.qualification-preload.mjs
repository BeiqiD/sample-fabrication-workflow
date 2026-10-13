// Explicit, private qualification diagnostic only. Imported definitions remain
// inert unless the parent opts in for its actual held Workflow CLI child.
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const enable = process.env.CURRENT_V28_WORKFLOW_ORIGINAL_MAIN_ERROR_OBSERVER;
const configPath = process.env.CURRENT_V28_WORKFLOW_HELD_READ_CONFIG;
if (enable === 'original-main/1' && configPath !== undefined) {
  const uid = BigInt(process.geteuid());
  function privateFile(path) {
    const value = lstatSync(path, { bigint: true });
    if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path
      || !value.isFile() || value.isSymbolicLink() || value.uid !== uid || value.nlink !== 1n
      || (value.mode & 0o7777n) !== 0o600n) throw new Error('Private original-main observer input is unavailable');
  }
  privateFile(configPath);
  const config = JSON.parse(readFileSync(configPath, 'utf8')), root = config.root;
  const directory = lstatSync(root, { bigint: true });
  if (config.schema !== 'actual-workflow-held-provider-read/1' || !isAbsolute(root) || resolve(root) !== root
    || realpathSync(root) !== root || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid
    || (directory.mode & 0o7777n) !== 0o700n || typeof config.origin !== 'string')
    throw new Error('Private original-main observer root is unavailable');
  const profile = process.argv.indexOf('--runtime-profile'), entry = process.argv[1];
  if (profile < 0 || process.argv[profile + 1] !== 'v28-workflow' || typeof entry !== 'string'
    || !isAbsolute(entry) || resolve(entry) !== entry || realpathSync(entry) !== entry || !entry.endsWith('/server/main.mjs'))
    throw new Error('Original compiled Workflow main is required');
  const entryCallsite = pathToFileURL(entry).href + ':';
  function publish(name, value) {
    const path = join(root, name + '.json'), pending = path + '.pending';
    try { lstatSync(path); throw new Error('Original-main observer marker already exists'); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    writeFileSync(pending, JSON.stringify({ ...value, pid: process.pid, observedAt: Date.now(),
      applicationCloseAcknowledged: false, qualificationPassed: false }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(pending, path);
  }
  // No mutable owner/Request/session object is traversed or printed. Read only
  // bounded original Error scalar fields, cause and AggregateError children.
  function describe(value, depth = 0, seen = new Set(), budget = { characters: 24576, objects: 24 }) {
    function bounded(text, maximum) { const count = Math.max(0, Math.min(maximum, budget.characters));
      const result = text.slice(0, count); budget.characters -= result.length; return result; }
    const kind = value === null ? 'null' : typeof value;
    if (kind === 'undefined' || kind === 'null') return { kind };
    if (kind === 'string') { const text = bounded(value, 8192); return { kind, value: text, truncated: value.length > text.length }; }
    if (kind === 'number' || kind === 'boolean') return { kind, value: String(value) };
    if (kind === 'bigint' || kind === 'symbol') return { kind, value: bounded(String(value), 1024) };
    if (depth >= 4 || seen.has(value) || budget.objects-- < 1) return { kind, opaque: true };
    seen.add(value); const result = { kind, error: value instanceof Error };
    for (const key of ['name', 'message', 'stack', 'code', 'errno', 'syscall', 'path']) {
      let descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (key === 'name' && !descriptor && value instanceof Error)
        descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
      const scalar = descriptor.value;
      if (typeof scalar === 'string') result[key] = bounded(scalar, key === 'stack' ? 12288 : 8192);
      else if (['number', 'boolean', 'bigint'].includes(typeof scalar)) result[key] = bounded(String(scalar), 1024);
    }
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && Object.hasOwn(cause, 'value')) result.cause = describe(cause.value, depth + 1, seen, budget);
    const errors = Object.getOwnPropertyDescriptor(value, 'errors');
    if (errors && Object.hasOwn(errors, 'value') && Array.isArray(errors.value)) {
      result.errors = errors.value.slice(0, 8).map(error => describe(error, depth + 1, seen, budget));
      result.errorsTruncated = errors.value.length > 8;
    }
    return result;
  }
  const originalCatch = Promise.prototype.catch, originalFunctionSource = Function.prototype.toString;
  const expected = '() => { process.stderr.write("Local development runtime unavailable.\\n"); process.exitCode = 1; }'.replace(/\s+/g, '');
  let selected = false;
  Promise.prototype.catch = function originalMainObserver(onRejected) {
    if (selected || typeof onRejected !== 'function'
      || originalFunctionSource.call(onRejected).replace(/\s+/g, '') !== expected
      || !String(new Error().stack).includes(entryCallsite)) return originalCatch.call(this, onRejected);
    selected = true;
    // All later domain/kernel/body promises immediately use the original
    // method. Only this exact original main terminal callback is observed.
    Promise.prototype.catch = originalCatch;
    try { publish('original-main-observer-selected', { schema: 'actual-original-main-error-observer/1',
      exactCompiledMainCallsite: true, exactTerminalCallback: true, originalCatchRestored: true }); } catch { /* No original flow change. */ }
    return originalCatch.call(this, function originalMainRejection(reason) {
      try { publish('original-main-rejection', { schema: 'actual-original-main-rejection/1',
        exactCompiledMainCallsite: true, exactTerminalCallback: true, originalReasonForwarded: true,
        originalCatchRestored: Promise.prototype.catch === originalCatch, original: describe(reason) }); }
      catch (observation) {
        try { publish('original-main-observer-failed', { schema: 'actual-original-main-error-observer-failed/1',
          originalReasonForwarded: true, observation: describe(observation) }); } catch { /* A missing marker proves no observation ACK. */ }
      }
      // Preserve the original callback's this, exact reason, return and throw.
      return Reflect.apply(onRejected, this, [reason]);
    });
  };
}
