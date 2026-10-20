// Fresh synthetic template SQL only. Never open a database or contact a service.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [sourceValue, outputValue, ...extra] = process.argv.slice(2);
assert(sourceValue && outputValue && extra.length === 0,
  'Usage: node generate-process-fixture.mjs ISOLATED_SOURCE_COPY NEW_PRIVATE_TEMP_OUTPUT');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const value = relative(root, path); return value !== '' && !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value); };
const temporaryAlias = resolve(tmpdir()), temporaryRoot = await realpath(temporaryAlias);
function temporaryPath(value) {
  assert(!value.split(/[\\/]/).includes('..'), 'Temporary paths must not contain parent traversal.');
  let path = resolve(value);
  if (path === temporaryAlias || within(temporaryAlias, path)) path = resolve(temporaryRoot, relative(temporaryAlias, path));
  assert(within(temporaryRoot, path), 'Use a directory below the canonical operating-system temporary directory.');
  return path;
}
async function noSymlinks(path) {
  let current = path;
  while (within(temporaryRoot, current)) {
    try { assert(!(await lstat(current)).isSymbolicLink(), 'Temporary descendants must not be symlinks.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
}
async function privateDirectory(path) {
  await noSymlinks(path);
  const info = await lstat(path);
  assert(info.isDirectory() && (info.mode & 0o777) === 0o700, 'Use an existing private mode-0700 directory.');
  if (process.getuid) assert.equal(info.uid, process.getuid(), 'The private directory must be owned by this user.');
  assert.equal(await realpath(path), path, 'Private directories must be canonical.');
}
const sourceRoot = temporaryPath(sourceValue), outputRoot = temporaryPath(outputValue);
await privateDirectory(sourceRoot); await noSymlinks(outputRoot);
assert(!within(sourceRoot, outputRoot) && !within(outputRoot, sourceRoot) && outputRoot !== sourceRoot,
  'Fixture output and source copy must be separate directories.');
assert((await lstat(dirname(outputRoot))).isDirectory(), 'The output parent must already exist.');
async function fileAt(root, value) {
  assert(typeof value === 'string' && value && !isAbsolute(value) && !value.split(/[\\/]/).includes('..'),
    'Receipt file paths must be bounded relative paths.');
  const path = resolve(root, value);
  assert(within(root, path) && !value.split(/[\\/]/).includes('node_modules'), 'Receipt files must remain inside the copied source.');
  await noSymlinks(path);
  assert((await lstat(path)).isFile(), 'Receipt entries must identify regular files.');
  return path;
}
const isolationPath = await fileAt(sourceRoot, 'isolation-receipt.json');
const isolationBytes = await readFile(isolationPath), isolation = JSON.parse(isolationBytes);
assert.equal(isolation.version, 2); assert.equal(isolation.copiedState, false);
assert.equal(isolation.sourceCopyRoot, sourceRoot);
assert(typeof isolation.sourceRoot === 'string' && isAbsolute(isolation.sourceRoot) && isolation.sourceRoot !== sourceRoot);
assert(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(isolation.sourceHead), 'A committed source HEAD is required.');
assert(typeof isolation.nodeModulesRoot === 'string' && isAbsolute(isolation.nodeModulesRoot));
assert((await lstat(resolve(sourceRoot, 'node_modules'))).isSymbolicLink(), 'The copied dependency directory must be the intentional receipt-owned link.');
async function hashInventory(inventory) {
  assert(inventory && typeof inventory === 'object' && !Array.isArray(inventory) && Object.keys(inventory).length,
    'A nonempty copied-file hash inventory is required.');
  for (const [name, expected] of Object.entries(inventory)) {
    assert(/^[a-f0-9]{64}$/.test(expected), 'Expected a SHA256 file identity.');
    assert.equal(sha(await readFile(await fileAt(sourceRoot, name))), expected, `Copied file changed: ${name}`);
  }
}
async function inspectTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), info = await lstat(path);
    if (info.isSymbolicLink()) {
      assert.equal(path, resolve(sourceRoot, 'node_modules'), 'Only the copied node_modules link is permitted.');
      assert.equal(await realpath(path), isolation.nodeModulesRoot, 'Dependency link must match its isolation receipt.');
    } else if (info.isDirectory()) await inspectTree(path);
    else assert(info.isFile(), 'Copied descendants must be regular files or directories.');
  }
}
await inspectTree(sourceRoot);
await hashInventory(isolation.trackedFiles); await hashInventory(isolation.copiedArtifactFiles);
assert.equal(sha(await readFile(new URL(import.meta.url))), isolation.trackedFiles['scripts/qa/phase5f/generate-process-fixture.mjs'],
  'Run the generator whose exact bytes were captured in the committed source copy.');
// mkdir is deliberately non-recursive: an existing output, including a failed
// earlier attempt, is never reused or overwritten.
await mkdir(outputRoot, { mode: 0o700 }); await privateDirectory(outputRoot);
const require = createRequire(resolve(sourceRoot, 'package.json'));
const { build } = require('esbuild');
const hashingPath = resolve(outputRoot, 'fixture-hashing.mjs');
await build({ entryPoints: [resolve(sourceRoot, 'shared/domain/content-addressing.ts')], outfile: hashingPath,
  bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
await chmod(hashingPath, 0o600);
const hash = await import(pathToFileURL(hashingPath));
const tag = randomUUID().slice(0, 12), prefix = `phase5f-${tag}`;
const ids = { family: `${prefix}-family`, v1: `${prefix}-v1`, v2: `${prefix}-v2` };
const initialStep = { localId: 'substrate', sourceRow: 1, position: 0, stepNumber: '0', name: 'Substrate Stack',
  sectionName: null, toolName: 'Synthetic substrate holder', parametersText: 'Silicon / oxide test stack',
  commentsText: 'Synthetic isolated acceptance fixture', rawCells: {}, stateImageIds: [] };
const state = await hash.hashInitialSubstrateRepresentation(initialStep, []);
const definitions = await Promise.all([
  { name: '5F solvent clean', toolName: 'Synthetic cleaning tool', parametersText: '30 s · safe fixture metadata', commentsText: 'No production experiment' },
  { name: '5F coat', toolName: 'Synthetic spinner', parametersText: '2500 rpm', commentsText: 'Long wrapped metadata for keyboard and responsive review' },
  { name: '5F inspect coating', toolName: 'Synthetic optical microscope', parametersText: '10×', commentsText: 'New future plan step' },
].map(async input => ({ ...input, ...await hash.hashStepDefinition(input) })));
const literal = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const insert = (table, columns, values) => `INSERT INTO ${table} (${columns.join(',')}) VALUES (${values.map(literal).join(',')});`;
const now = '2026-10-10T00:00:00.000Z', sql = [];
sql.push(insert('recipe_families', ['id', 'name', 'template_type', 'created_by', 'created_at'], [ids.family, `5F mixed process ${tag}`, 'process', 'synthetic-browser-fixture', now]));
sql.push(insert('state_representations', ['hash', 'hash_scheme', 'representation_type', 'content_json', 'created_at'],
  [state.hash, hash.SUBSTRATE_STATE_HASH_SCHEME, 'substrate', hash.stableJson(state.canonical), now]));
for (const step of definitions) sql.push(insert('step_definitions', ['hash', 'hash_scheme', 'name', 'tool_name', 'parameters_text', 'comments_text', 'canonical_json', 'created_at'],
  [step.hash, hash.STEP_HASH_SCHEME, step.name, step.toolName, step.parametersText, step.commentsText, hash.stableJson(step.canonical), now]));
for (const [version, templateId, count] of [[1, ids.v1, 2], [2, ids.v2, 3]]) {
  const descriptors = definitions.slice(0, count).map((step, position) => ({ logicalStepKey: hash.logicalStepKey(step, 1), definitionHash: step.hash, expectedStateHash: null }));
  const manifestHash = await hash.hashRecipeManifest(descriptors);
  sql.push(insert('template_versions', ['id', 'recipe_family_id', 'name', 'template_type', 'template_kind', 'version', 'manifest_hash', 'initial_state_hash', 'content_json', 'created_by', 'created_at'],
    [templateId, ids.family, `5F mixed process ${tag}`, 'process', 'process', version, manifestHash, state.hash,
      JSON.stringify({ initialSubstrateStep: initialStep }), 'synthetic-browser-fixture', now]));
  definitions.slice(0, count).forEach((step, position) => sql.push(insert('template_steps',
    ['id', 'template_version_id', 'logical_step_key', 'position', 'step_number', 'section_name', 'definition_hash', 'expected_state_hash', 'raw_json'],
    [`${templateId}-step-${position}`, templateId, descriptors[position].logicalStepKey, position, String(position + 1), 'Synthetic acceptance', step.hash, null, '{}'])));
}
const body = sql.join('\n') + '\n';
await hashInventory(isolation.trackedFiles); await hashInventory(isolation.copiedArtifactFiles);
assert.equal(sha(await readFile(isolationPath)), sha(isolationBytes), 'Isolation receipt changed during generation.');
await privateDirectory(outputRoot);
await writeFile(resolve(outputRoot, 'process-fixture.sql'), body, { flag: 'wx', mode: 0o600 });
await writeFile(resolve(outputRoot, 'process-fixture.json'), JSON.stringify({ version: 2, prefix, ids, familyName: `5F mixed process ${tag}`,
  sourceRoot: isolation.sourceRoot, sourceCopyRoot: sourceRoot, sourceHead: isolation.sourceHead,
  fixtureDirectory: outputRoot, isolationReceiptSha256: sha(isolationBytes), copiedState: false,
  initialSubstrateStep: initialStep, initialStateHash: state.hash, sqlSha256: sha(body),
  helperSha256: sha(await readFile(new URL(import.meta.url))), hashingModuleSha256: sha(await readFile(hashingPath)),
  loopbackPort: 4219, scope: 'Hashed synthetic process templates only; apply exclusively to isolated local fixture DB after review.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ sql: resolve(outputRoot, 'process-fixture.sql'), manifest: resolve(outputRoot, 'process-fixture.json'), prefix }));
