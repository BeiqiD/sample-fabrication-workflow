// Explicit private qualification only. Definitions are inert unless the parent
// opts in for this SAME original compiled stopped-capture CLI child.
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const enable = process.env.CURRENT_V28_COMMENT_ORIGINAL_MAIN_ERROR_OBSERVER;
const configPath = process.env.CURRENT_V28_COMMENT_ORIGINAL_MAIN_ERROR_CONFIG;
if (enable === 'original-main/1' && configPath !== undefined) {
  const uid = BigInt(process.geteuid());
  function privateFile(path) {
    const value = lstatSync(path, { bigint: true });
    if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path
      || !value.isFile() || value.isSymbolicLink() || value.uid !== uid || value.nlink !== 1n
      || (value.mode & 0o7777n) !== 0o600n) throw new Error('Private original capture observer input is unavailable');
  }
  privateFile(configPath);
  const config = JSON.parse(readFileSync(configPath, 'utf8')), root = config.root;
  const directory = lstatSync(root, { bigint: true });
  if (config.schema !== 'actual-comment-stopped-capture-original-main-observer/1'
    || Object.keys(config).sort().join(',') !== 'configuration,entry,root,schema'
    || !isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root
    || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid
    || (directory.mode & 0o7777n) !== 0o700n) throw new Error('Private original capture observer root is unavailable');
  privateFile(config.configuration);
  const profile = process.argv.indexOf('--runtime-profile'), configuration = process.argv.indexOf('--configuration'), entry = process.argv[1];
  if (process.argv[2] !== 'capture-local-backup' || profile < 0 || process.argv[profile + 1] !== 'v28'
    || configuration < 0 || process.argv[configuration + 1] !== config.configuration
    || typeof entry !== 'string' || entry !== config.entry || !isAbsolute(entry) || resolve(entry) !== entry
    || realpathSync(entry) !== entry || !entry.endsWith('/server/installation-cli.cjs'))
    throw new Error('Same original compiled stopped capture CLI is required');
  const entryCallsites = [entry + ':', pathToFileURL(entry).href + ':'];
  function publish(name, value) {
    const path = join(root, name + '.json'), pending = path + '.pending';
    try { lstatSync(path); throw new Error('Original capture observer marker already exists'); }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    const serialized = JSON.stringify({ ...value, pid: process.pid, observedAt: Date.now(),
      applicationCloseAcknowledged: false, qualificationPassed: false }) + '\n';
    if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Original capture observer receipt budget exceeded');
    writeFileSync(pending, serialized, { flag: 'wx', mode: 0o600 });
    renameSync(pending, path);
  }
  // Only bounded original Error scalar descriptors/cause/AggregateError children
  // enter these PRIVATE600 files. No stdout/stderr, mutable owner or SQL I/O.
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
  const expected = "()=>{if(process.argv[2]===\"capture-local-backup\"){process.stderr.write(\"StoppedlocalV28backupcaptureunavailable;retaintheoriginaloutcomebeforeconsideringanothercapture.\\n\");process.exitCode=1;return;}if(process.argv[2]===\"release-restored-maintenance\"){process.stderr.write(\"StoppedrestoredV28maintenancereleaseunavailable;reconcilethesamerequestID.\\n\");process.exitCode=1;return;}if(process.argv[2]===\"enroll-local-member\"||process.argv[2]===\"set-enforcement\"){process.stderr.write(\"Offlinecollaborationoperationunavailable.\\n\");process.exitCode=1;return;}process.stderr.write(process.argv[2]===\"inspect\"?\"Offlineinstallationinspectionunavailable.\\n\":\"Offlineinstallationupgradeunavailable.\\n\");process.exitCode=1;}";
  let selected = false;
  Promise.prototype.catch = function originalCaptureMainObserver(onRejected) {
    if (selected || typeof onRejected !== 'function'
      || originalFunctionSource.call(onRejected).replace(/\s+/g, '') !== expected
      || !entryCallsites.some(callsite => String(new Error().stack).includes(callsite))) return originalCatch.call(this, onRejected);
    selected = true;
    Promise.prototype.catch = originalCatch;
    try { publish('original-capture-main-observer-selected', { schema: 'actual-original-capture-main-error-observer/1',
      exactCompiledMainCallsite: true, exactTerminalCallback: true, originalCatchRestored: true }); } catch { /* No original flow change. */ }
    return originalCatch.call(this, function originalCaptureMainRejection(reason) {
      try { publish('original-capture-main-rejection', { schema: 'actual-original-capture-main-rejection/1',
        exactCompiledMainCallsite: true, exactTerminalCallback: true, originalReasonForwarded: true,
        originalCatchRestored: Promise.prototype.catch === originalCatch, original: describe(reason) }); }
      catch (observation) {
        try { publish('original-capture-main-observer-failed', { schema: 'actual-original-capture-main-error-observer-failed/1',
          originalReasonForwarded: true, observation: describe(observation) }); } catch { /* Missing marker proves no observation ACK. */ }
      }
      return Reflect.apply(onRejected, this, [reason]);
    });
  };
}
