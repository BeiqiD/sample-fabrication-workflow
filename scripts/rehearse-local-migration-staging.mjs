import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";
import { observeD1Migrations } from "./d1-migration-observer.mjs";
import { migrationSqlHash, normalizeSchema, planD1Migrations, schemaFingerprint } from "./d1-migration-plan.mjs";
import { applyHostTransaction, compatibilityDirectory, generateS2Baseline, observeHostSchema, readSchemaSources } from "./lib/backend-schema-baseline.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = resolve(dirname(require.resolve("wrangler/package.json")), require("wrangler/package.json").bin.wrangler);
const execute = promisify(execFile);
const baselineName = "0001_v3_baseline.sql";
const stageNames = ["0037_compatibility_bridge.sql", "0038_final_schema.sql"];
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const observationHash = (value) => migrationSqlHash(JSON.stringify({ schema: normalizeSchema(value.schema), ledger: value.ledger }));
const sortedRows = (rows) => rows.map((row) => JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();

// Source paths and expected schemas originate only in this checked-out code.
// No target observation, archive SQL, user catalog or CLI argument supplies SQL.
async function trustedCatalog() {
  const { historical, stages } = readSchemaSources(root);
  const baselinePath = `${compatibilityDirectory}/s2-baseline.sql`;
  const baseline = await readFile(join(root, baselinePath), "utf8");
  const generated = generateS2Baseline(root);
  assert.equal(baseline, generated.sql, "Reviewed baseline no longer matches its exact historical and stage source hashes");
  const sources = [
    ...historical.map((source) => ({ ...source, path: source.filename, filename: basename(source.filename), kind: "historical" })),
    ...stages.map((source, index) => ({ ...source, path: source.filename, filename: stageNames[index], kind: "incremental" })),
    { path: baselinePath, filename: baselineName, sql: baseline, kind: "baseline" },
  ].map((source) => ({ ...source, sha256: migrationSqlHash(source.sql) }));
  const database = new DatabaseSync(":memory:");
  try {
    const supportedStates = [];
    for (const [index, source] of sources.slice(0, -1).entries()) {
      applyHostTransaction(database, source.sql);
      if (index >= 36) supportedStates.push({ appliedCount: index + 1, schema: observeHostSchema(database) });
    }
    return { sources, baselineTables: generated.tables, catalog: {
      version: 1, freshLineage: "qualified-empty-s2",
      sources: sources.map(({ filename, sha256, kind }) => ({ filename, sha256, kind })),
      lineages: [
        { id: "retained-historical", kind: "legacy", migrations: sources.slice(0, -1).map(({ filename }) => filename), supportedStates },
        { id: "qualified-empty-s2", kind: "baseline", migrations: [baselineName], supportedStates: [{ appliedCount: 1, schema: generated.schema }] },
      ],
    } };
  } finally { database.close(); }
}

async function plainFile(path) {
  const info = await lstat(path);
  assert(info.isFile() && info.nlink === 1, `Expected a private ordinary file: ${path}`);
  return readFile(path, "utf8");
}

async function verifySources(trusted) {
  for (const source of trusted.sources) assert.equal(migrationSqlHash(await plainFile(join(root, source.path))), source.sha256,
    `Source hash drift: ${source.path}`);
  assert.deepEqual((await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort(),
    trusted.sources.filter(({ kind }) => kind === "historical").map(({ filename }) => filename), "Historical source inventory drift");
}

async function verifyPrivateState(paths) {
  for (const path of [paths.directory, paths.persist]) {
    const info = await lstat(path);
    assert(info.isDirectory(), "An isolated directory was replaced by a symlink or file");
    const original = paths.identities[path];
    assert(info.dev === original.dev && info.ino === original.ino, "An isolated directory was replaced");
  }
  const walk = async (directory) => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), info = await lstat(path);
      assert(!info.isSymbolicLink(), "Local persistence must not contain a symlink");
      if (info.isDirectory()) await walk(path);
      else assert(info.isFile() && info.nlink === 1, "Local persistence must contain private ordinary files");
    }
  };
  await walk(paths.persist);
}

function expectedTables(before, after, baselineTables) {
  if (!Object.keys(before.tables).length) return Object.keys(after.tables).length ? baselineTables : {};
  const names = new Set(after.observation.schema.relations.find(({ name }) => name === "run_step_comments").columns.map(({ name }) => name));
  const sampleNames = new Set(after.observation.schema.relations.find(({ name }) => name === "samples").columns.map(({ name }) => name));
  return Object.fromEntries(Object.entries(before.tables).map(([name, rows]) => [name, rows.map((row) => {
    const value = { ...row };
    if (name === "samples" && !sampleNames.has("process_revision")) delete value.process_revision;
    if (name === "run_step_comments") {
      if (names.has("legacy_body") && !Object.hasOwn(value, "legacy_body")) value.legacy_body = value.submission_id === null ? value.body : null;
      if (!names.has("body")) delete value.body;
    }
    return value;
  })]));
}

async function withDatabase(paths, operation) {
  await verifyPrivateState(paths);
  const proxy = await getPlatformProxy({ configPath: paths.config, persist: { path: join(paths.persist, "v3") }, remoteBindings: false, envFiles: [] });
  try { return await operation(proxy.env.DB); }
  finally { await proxy.dispose(); }
}

async function inspect(paths) {
  return withDatabase(paths, async (database) => {
    const observation = await observeD1Migrations(database);
    const names = normalizeSchema(observation.schema).objects.filter(({ type }) => type === "table").map(({ name }) => name);
    const results = names.length ? await database.batch(names.map((name) => database.prepare(`SELECT * FROM ${quote(name)}`))) : [];
    assert(results.every(({ success, results }) => success && Array.isArray(results)), "Incomplete isolated data observation");
    return { observation, tables: Object.fromEntries(names.map((name, index) => [name, results[index].results])) };
  });
}

async function invokeWrangler(paths, arguments_, label) {
  await verifyPrivateState(paths);
  // Deliberately construct local-only arguments and a credential-free process.
  // No extra arguments, external config, environment file or remote mode exists.
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "SYSTEMROOT", "COMSPEC"]
    .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  Object.assign(env, { CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" });
  const args = [wrangler, "d1", ...arguments_, "DB", "--local", "--config", paths.config, "--persist-to", paths.persist];
  const receipt = { executable: process.execPath, args, startedAt: new Date().toISOString(), success: false };
  try {
    const result = await execute(process.execPath, args, { cwd: paths.directory, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    Object.assign(receipt, { success: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    Object.assign(receipt, { exitCode: error.code, signal: error.signal, stdout: error.stdout ?? "", stderr: error.stderr ?? "", error: error.message });
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(paths.directory, `${label}.json`), json(receipt), { flag: "wx", mode: 0o600 });
  return receipt;
}

/** Create only a NEW private fixture, never open an existing user/database path. */
export async function createLocalMigrationRehearsal(options) {
  assert(options && typeof options === "object" && !Array.isArray(options)
    && Object.keys(options).every((name) => ["destination", "fixture"].includes(name)), "Only a new destination and a fixed fixture may be selected");
  const { destination, fixture = "empty" } = options;
  assert(typeof destination === "string" && destination.length, "A new isolated destination is required");
  assert(["empty", "retained", "retained-s1"].includes(fixture), "Unknown fixed local fixture");
  const trusted = await trustedCatalog();
  const directory = resolve(destination);
  await mkdir(directory, { mode: 0o700 }); // Exclusive reservation; EEXIST is never overwritten.
  const paths = { directory, config: join(directory, "wrangler.json"), persist: join(directory, "state") };
  await mkdir(paths.persist, { mode: 0o700 });
  paths.identities = Object.fromEntries(await Promise.all([paths.directory, paths.persist].map(async (path) => {
    const { dev, ino } = await lstat(path);
    return [path, { dev, ino }];
  })));
  const identity = randomUUID();
  const bootstrap = join(directory, "bootstrap");
  await mkdir(bootstrap, { mode: 0o700 });
  const configuration = (migrations) => json({ name: "isolated-backend-migration-rehearsal", compatibility_date: "2026-07-01",
    d1_databases: [{ binding: "DB", database_name: "isolated-backend-migration-rehearsal", database_id: identity, migrations_dir: migrations }] });
  let configText = configuration(bootstrap);
  await writeFile(paths.config, configText, { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "identity.json"), json({ kind: "exclusive-local-migration-rehearsal", identity, fixture, remoteExecutionAuthorized: false }), { flag: "wx", mode: 0o600 });
  if (fixture !== "empty") {
    for (const source of trusted.sources.filter(({ kind }) => kind === "historical")) {
      await writeFile(join(bootstrap, source.filename), source.sql, { flag: "wx", mode: 0o600 });
    }
    const historical = await invokeWrangler(paths, ["migrations", "apply"], "bootstrap-historical");
    assert(historical.success, `Actual local Wrangler historical setup failed: ${historical.stderr}`);
    const seedPath = join(directory, "retained-fixture.sql");
    const seed = await readFile(join(root, "worker/fixtures/reference-graph.sql"), "utf8") + "\n"
      + await readFile(join(root, compatibilityDirectory, "retained-data.sql"), "utf8");
    await writeFile(seedPath, seed, { flag: "wx", mode: 0o600 });
    const seeded = await invokeWrangler(paths, ["execute", "--file", seedPath], "bootstrap-retained-data");
    assert(seeded.success, `Actual local Wrangler fixture setup failed: ${seeded.stderr}`);
    if (fixture === "retained-s1") {
      await writeFile(join(bootstrap, stageNames[0]), trusted.sources.find(({ filename }) => filename === stageNames[0]).sql, { flag: "wx", mode: 0o600 });
      const expanded = await invokeWrangler(paths, ["migrations", "apply"], "bootstrap-s1");
      assert(expanded.success, `Actual local Wrangler S1 setup failed: ${expanded.stderr}`);
    }
  }
  const initial = await inspect(paths);
  planD1Migrations({ catalog: trusted.catalog, sourceFiles: trusted.sources, target: initial.observation });
  const preservationText = json(initial);
  await writeFile(join(directory, "preserved-before.json"), preservationText, { flag: "wx", mode: 0o600 });
  let pending;
  let busy = false;
  let attempt = 0;
  const exclusive = async (operation) => {
    assert(!busy, "This isolated rehearsal already has an operation in progress");
    busy = true;
    try { return await operation(); } finally { busy = false; }
  };
  return {
    paths: Object.freeze({ directory: paths.directory, config: paths.config, persist: paths.persist }),
    observe: () => exclusive(() => inspect(paths)),
    prepare: () => exclusive(async () => {
      pending = undefined;
      await verifySources(trusted);
      assert.equal(await plainFile(paths.config), configText, "Local configuration drift");
      const before = await inspect(paths);
      const proposal = planD1Migrations({ catalog: trusted.catalog, sourceFiles: trusted.sources, target: before.observation });
      const staging = await mkdtemp(join(directory, "staged-"));
      for (const migration of proposal.migrations) {
        const source = trusted.sources.find(({ filename }) => filename === migration.filename);
        await writeFile(join(staging, migration.filename), source.sql, { flag: "wx", mode: 0o600 });
      }
      configText = configuration(staging);
      await writeFile(paths.config, configText, { mode: 0o600 });
      pending = { proposal, before, staging, sourceHashes: trusted.sources.map(({ path, filename, sha256 }) => ({ path, filename, sha256 })) };
      await writeFile(join(staging, "../", `proposal-${++attempt}.json`), json({ ...pending, remoteExecutionAuthorized: false }), { flag: "wx", mode: 0o600 });
      return structuredClone(pending);
    }),
    apply: () => exclusive(async () => {
      assert(pending, "Prepare and validate an isolated local proposal first");
      const accepted = pending;
      assert.equal(await plainFile(join(directory, "preserved-before.json")), preservationText, "Preserved original data or ledger evidence drift");
      pending = undefined;
      await verifySources(trusted);
      assert.equal(await plainFile(paths.config), configText, "Local configuration drift");
      assert((await lstat(accepted.staging)).isDirectory(), "Staging directory must not be a symlink");
      assert.deepEqual((await readdir(accepted.staging)).sort(), accepted.proposal.migrations.map(({ filename }) => filename).sort(), "Staging inventory drift");
      for (const migration of accepted.proposal.migrations) assert.equal(migrationSqlHash(await plainFile(join(accepted.staging, migration.filename))), migration.sha256,
        `Staging source hash drift: ${migration.filename}`);
      const before = await inspect(paths);
      assert.equal(observationHash(before.observation), observationHash(accepted.before.observation), "Target schema or ledger observation drift");
      assert.deepEqual(planD1Migrations({ catalog: trusted.catalog, sourceFiles: trusted.sources, target: before.observation }), accepted.proposal, "Migration selection drift");
      if (!accepted.proposal.migrations.length) return { kind: "local-no-op", remoteExecutionAuthorized: false };
      const receipt = await invokeWrangler(paths, ["migrations", "apply"], `apply-${attempt}`);
      const after = await inspect(paths);
      const remaining = planD1Migrations({ catalog: trusted.catalog, sourceFiles: trusted.sources, target: after.observation });
      assert.deepEqual(after.observation.ledger.rows.slice(0, before.observation.ledger.rows.length), before.observation.ledger.rows, "Existing migration ledger rows changed");
      const expected = expectedTables(before, after, trusted.baselineTables);
      assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(expected).sort(), "Application table inventory changed unexpectedly");
      for (const [name, rows] of Object.entries(expected)) assert.deepEqual(sortedRows(after.tables[name]), sortedRows(rows), `Retained application rows changed: ${name}`);
      const health = await withDatabase(paths, async (database) => database.batch([
        database.prepare("PRAGMA foreign_key_check"), database.prepare("PRAGMA quick_check"), database.prepare("PRAGMA foreign_keys"),
      ]));
      assert(Array.isArray(health) && health.length === 3 && health.every(({ success, results }) => success && Array.isArray(results))
        && health[0].results.length === 0 && health[1].results.length === 1
        && Object.keys(health[1].results[0]).length === 1 && health[1].results[0].quick_check === "ok"
        && health[2].results.length === 1 && health[2].results[0].foreign_keys === 1, "Local D1 integrity checks failed");
      const report = { kind: "local-wrangler-migration-rehearsal", remoteExecutionAuthorized: false, receipt,
        preservationSha256: migrationSqlHash(preservationText), dataPreserved: true, sourceHashes: accepted.sourceHashes, proposal: accepted.proposal, before, after, remaining };
      if (!receipt.success) {
        report.outcome = "apply-failed";
        await writeFile(join(directory, `result-${attempt}.json`), json(report), { flag: "wx", mode: 0o600 });
        throw Object.assign(new Error("Actual local Wrangler migration failed; inspect its receipt and prepare again before retry"), { code: "LOCAL_MIGRATION_APPLY_FAILED", report });
      }
      assert.deepEqual(remaining.migrations, [], "Wrangler left selected migrations unapplied");
      assert.equal(schemaFingerprint(after.observation.schema), accepted.proposal.expectedFinalSchemaHash, "Final schema differs from the reviewed lineage");
      assert.deepEqual(after.observation.ledger.rows.map(({ name }) => name), [...before.observation.ledger.rows.map(({ name }) => name), ...accepted.proposal.migrations.map(({ filename }) => filename)], "Wrangler applied an unexpected ledger suffix");
      report.outcome = "verified-local-success";
      await writeFile(join(directory, `result-${attempt}.json`), json(report), { flag: "wx", mode: 0o600 });
      return report;
    }),
  };
}

// Manual local qualification has exactly one argument pair. This is deliberately
// not a deployment command and cannot select a target, resource, config or SQL.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 4 && process.argv[2] === "--destination", "Usage: node scripts/rehearse-local-migration-staging.mjs --destination NEW_DIRECTORY");
  const destination = resolve(process.argv[3]);
  await mkdir(destination, { mode: 0o700 });
  for (const fixture of ["empty", "retained"]) {
    const session = await createLocalMigrationRehearsal({ destination: join(destination, fixture), fixture });
    const proposal = await session.prepare();
    const result = await session.apply();
    console.log(json({ fixture, selected: proposal.proposal.migrations, finalSchema: result.remaining.observedSchemaHash, remoteExecutionAuthorized: false }));
  }
}
