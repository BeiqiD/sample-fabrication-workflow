// Finite populated current-baseline upgrade qualification. Every migration is
// applied by installed Wrangler to new local-only persistence; fixture SQL is
// explicit synthetic setup and never public-API or provider qualification.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getPlatformProxy, unstable_splitSqlQuery as splitSql } from "wrangler";
import { observeD1Migrations } from "./d1-migration-observer.mjs";
import { normalizeSchema, schemaFingerprint } from "./d1-migration-plan.mjs";
import { applyHostTransaction, observeHostSchema } from "./lib/backend-schema-baseline.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url), execute = promisify(execFile);
const wrangler = resolve(dirname(require.resolve("wrangler/package.json")), require("wrangler/package.json").bin.wrangler);
const names = ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql", "0004_r2_upload_acceptance.sql",
  "0005_metrology_reference_acceptance.sql", "0006_comment_acceptance.sql", "0007_fp1_file_authority_transition.sql", "0008_fp1_shadow_runtime.sql",
  "0009_fp1_shadow_withdrawals.sql", "0010_fp1_shadow_adjudications.sql", "0011_fp1_retire_legacy_test_projects.sql", "0012_fp1_file_authority_runtime.sql",
  "0013_fp1_r2_role_defaults.sql", "0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql", "0016_fp2_credential_reenvelopes.sql",
  "0017_fp2_native_storage_profiles.sql", "0018_fp2_native_file_runtime.sql", "0019_fp3_file_jobs.sql", "0020_fp4_research_packages.sql",
  "0021_fp5_system_recovery.sql", "0022_fp5_recovery_evidence.sql", "0023_portable_local_identity.sql", "0024_rt3_local_volume_profiles.sql",
  "0025_scheduler_fair_turn.sql"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const quote = name => `"${name.replaceAll('"', '""')}"`;
const ordered = rows => rows.map(row => JSON.stringify(row)).sort();
const faultName = "qa_current_migration_ledger_fault";
const faultSql = `CREATE TRIGGER ${faultName} BEFORE INSERT ON d1_migrations WHEN NEW.name='${names[18]}' BEGIN SELECT RAISE(ABORT,'QA current migration19 ledger fault'); END;`;
const clock = "2026-10-15T00:00:00.000Z", sha = "a".repeat(64);

async function freezeSources() {
  assert.equal(process.version, "v24.19.0", "Use the repository's pinned Node runtime");
  assert.deepEqual((await readdir(join(source, "migrations"))).filter(name => name.endsWith(".sql")).sort(), names);
  const sql = await Promise.all(names.map(name => readFile(join(source, "migrations", name), "utf8")));
  assert.equal(sql[0], await readFile(join(source, "scripts/fixtures/backend-schema/s2-baseline.sql"), "utf8"));
  const historical = [...sql[0].matchAll(/^-- Source migrations\/([^ /]+\.sql) sha256=([a-f0-9]{64})$/gm)];
  assert.equal(historical.length, 37);
  assert.deepEqual((await readdir(join(source, "migrations-history/s0"))).filter(name => name.endsWith(".sql")).sort(), historical.map(row => row[1]).sort());
  for (const [, name, digest] of historical) assert.equal(hash(await readFile(join(source, "migrations-history/s0", name))), digest, name);
  const encoderPath = "shared/contracts/system-recovery-image.ts", encoder = await readFile(join(source, encoderPath), "utf8");
  // Use the actual source function, without a copied numeric/typed-cell codec
  // or an application build. This final export has no external dependencies.
  const start = encoder.indexOf("export function recoveryTableSnapshotSql(");
  assert(start >= 0); const exported = stripTypeScriptTypes(encoder.slice(start));
  const { recoveryTableSnapshotSql } = await import(`data:text/javascript;base64,${Buffer.from(exported).toString("base64")}`);
  const host = new DatabaseSync(":memory:"), schemas = new Map();
  try {
    host.exec("PRAGMA foreign_keys=ON");
    for (const [index, contents] of sql.entries()) {
      applyHostTransaction(host, contents);
      if (index >= 16) schemas.set(index + 1, normalizeSchema(observeHostSchema(host)));
    }
  } finally { host.close(); }
  const [commit, status, manifest, lock] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], { cwd: source }),
    execute("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: source }),
    readFile(join(source, "package.json")), readFile(join(source, "package-lock.json")),
  ]);
  return { sql, schemas, recoveryTableSnapshotSql, evidence: { source, sourceCommit: commit.stdout.trim(), node: process.version,
    dirtySource: status.stdout.length > 0, workingTreeStatus: status.stdout.trim(),
    packageManifestSha256: hash(manifest), packageLockSha256: hash(lock),
    wrangler: require("wrangler/package.json").version, workerd: require("workerd/package.json").version,
    sourceQualification: "Exact SQL bytes and named helper inputs; no application-build or clean-working-tree claim",
    migrations: names.map((name, index) => ({ name, sha256: hash(sql[index]) })),
    historical: historical.map(([, name, sha256]) => ({ name, sha256 })),
    helperSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    encoder: { path: encoderPath, sha256: hash(encoder), executedFunctionSha256: hash(exported) },
    referenceFixtureSha256: hash(await readFile(join(source, "worker/fixtures/reference-graph.sql"))) } };
}

async function assertSources(frozen) {
  assert.deepEqual((await readdir(join(source, "migrations"))).filter(name => name.endsWith(".sql")).sort(), names);
  for (const [index, name] of names.entries()) assert.equal(await readFile(join(source, "migrations", name), "utf8"), frozen.sql[index], `Frozen SQL changed: ${name}`);
}

function stageSeed(prefix) {
  if (prefix === 17) return `
    INSERT INTO storage_profiles(rowid,id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at)
      VALUES(CAST('-9007199254740993' AS INTEGER),'qa-r2-a','r2','qa:local-r2:a','bootstrap',NULL,1,'historical','${clock}'),
            (42,'qa-r2-b','r2','qa:local-r2:b','bootstrap',NULL,1,'historical','${clock}');
    INSERT INTO files(rowid,id,purpose,access_scope,expected_byte_size,expected_sha256,verified_sha256,state,active_location_id,created_at)
      VALUES(-17,'qa-file-a','research_source','system',4,'${sha}',NULL,'unresolved',NULL,'${clock}'),
            (37,'qa-file-b','research_source','system',4,'${sha}',NULL,'unresolved',NULL,'${clock}');
    INSERT INTO file_locations(rowid,id,file_id,storage_profile_id,object_key,state,created_at)
      VALUES(-19,'qa-location-a','qa-file-a','qa-r2-a','shared-key','unresolved','${clock}'),
            (41,'qa-location-b','qa-file-b','qa-r2-b','shared-key','unresolved','${clock}');
    INSERT INTO legacy_file_mappings(store_kind,provider,object_key,file_id,location_id,classification,evidence_json,observed_at)
      VALUES('r2','r2','shared-key','qa-file-a','qa-location-a','classified','{}','${clock}');
    INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,request_input_json,request_scope,
      storage_profile_id,storage_profile_revision,storage_policy_revision,candidate_asset_id,candidate_object_key,status,created_at,expires_at)
      VALUES('10000000-0000-4000-8000-000000000001','fixture@example.test','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003',
      'ordinary_image','embedded_content','${sha}','{"schema":"r2-upload-request/1","ingress":"ordinary_image","purpose":"embedded_content","scope":"system","file":{"originalName":"qa.png","mimeType":"image/png","byteSize":4,"sha256":"${sha}"}}',
      'system','qa-r2-a',1,1,'10000000-0000-4000-8000-000000000004','qa/candidate','pending','${clock}','2026-10-16T00:00:00.000Z');
    INSERT INTO run_step_comments(id,run_step_id,scope,operation_group_id,legacy_body,submission_id,actor_email,created_at,updated_at)
      VALUES('qa-legacy-nul','reference-step-a','individual',NULL,CAST(X'410042' AS TEXT),NULL,'fixture@example.test','${clock}','${clock}'),
            ('qa-legacy-blob','reference-step-b','individual',NULL,X'000102FF',NULL,'fixture@example.test','${clock}','${clock}');
    INSERT INTO projects(id,title,last_mutation_id,created_by,updated_by,created_at,updated_at,deleted_at,deleted_by,deletion_operation_id)
      VALUES('qa-project','Retained Project','qa-project-create','fixture@example.test','fixture@example.test','${clock}','${clock}',NULL,NULL,NULL),
            ('qa-deleted-project','Retained deleted Project','qa-project-delete','fixture@example.test','fixture@example.test','${clock}','${clock}','${clock}','fixture@example.test','qa-project-delete');
    INSERT INTO project_contents(id,project_id,content_type,markdown_source,last_mutation_id,created_by,updated_by,created_at,updated_at)
      VALUES('qa-project-markdown','qa-project','markdown','# Retained Project source','qa-content-create','fixture@example.test','fixture@example.test','${clock}','${clock}');
    INSERT INTO samples(id,code,title,status,location,pinned,created_at,updated_at,deleted_at)
      VALUES('qa-deleted-sample','QA-DEL','Retained deleted Sample','stored','Archive',0,'${clock}','${clock}','${clock}');
    UPDATE assets SET rowid=CAST('9223372036854775806' AS INTEGER) WHERE id='reference-execution-asset';
    UPDATE samples SET rowid=CAST('-9223372036854775807' AS INTEGER) WHERE id='reference-sample-a';`;
  if (prefix === 19) return `INSERT INTO file_migration_jobs(id,request_id,actor,input_json,target_profile_id,target_configuration_revision,target_namespace,accepted_at,state,updated_at)
    VALUES('qa-file-job','qa-file-request','fixture@example.test','{"requestId":"qa-file-request","fileIds":["qa-file-a"],"target":{"profileId":"qa-r2-b","configurationRevision":1}}',
      'qa-r2-b',1,'qa:local-r2:b','${clock}','paused','${clock}');`;
  if (prefix === 20) return `INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,source_installation_id,accepted_at,target_policy_json,state,phase,updated_at)
    SELECT 'qa-package-job','qa-package-request','fixture@example.test','report','{"requestId":"qa-package-request","kind":"report"}','qa-package',installation_id,'${clock}','{}','paused','snapshot','${clock}' FROM research_package_source_identity;
    INSERT INTO research_package_requests(actor,request_id,input_json,job_id,accepted_at,reused)
      VALUES('fixture@example.test','qa-package-request','{"requestId":"qa-package-request","kind":"report"}','qa-package-job','${clock}',0);
    INSERT INTO research_package_records VALUES('qa-package-job','sample','reference-sample-a','{"note":"retained package snapshot"}',0);`;
  if (prefix === 21) return `INSERT INTO system_recovery_jobs(id,request_id,actor,kind,state,phase,input_json,accepted_at,updated_at)
      VALUES('qa-recovery-job','qa-recovery-request','fixture@example.test','backup','paused','snapshot','{"requestId":"qa-recovery-request","kind":"backup","mode":"historical"}','${clock}','${clock}');
    INSERT INTO system_recovery_requests VALUES('qa-recovery-request','fixture@example.test','qa-recovery-job','${sha}','${clock}');
    INSERT INTO system_recovery_metadata_chunks VALUES('qa-recovery-job','retained-proof',0,CAST(X'410042' AS TEXT));
    INSERT INTO system_recovery_maintenance_requests VALUES('qa-enter-history','fixture@example.test','enter',0,'{"state":"draining","generation":1}','${clock}');`;
  if (prefix === 23) return `INSERT INTO local_accounts VALUES('qa-principal','qa-operator','synthetic-fixture-verifier',1,1,1700000000000);
    INSERT INTO local_identity_installation VALUES(1,'qa-principal','local-identity-v1',1700000000000);
    INSERT INTO local_admin_grants VALUES('qa-principal',1700000000000);
    INSERT INTO local_sessions VALUES('${"b".repeat(64)}','qa-principal',1,1700000000000,1700000300000,1700000000000,NULL);
    INSERT INTO local_auth_events VALUES(1,'qa-principal','bootstrap',1700000000000);`;
  return "";
}

async function createFixture(root, name, frozen, signal) {
  const directory = join(root, name); await mkdir(directory, { mode: 0o700 });
  const staging = join(directory, "staged"), persist = join(directory, "state"), config = join(directory, "local-config.json");
  await mkdir(staging, { mode: 0o700 });
  const databaseId = randomUUID(), configText = json({ name: "current-chain-local-qualification", compatibility_date: "2026-07-20",
    d1_databases: [{ binding: "DB", database_name: "current-chain-fixture", database_id: databaseId, migrations_dir: staging }] });
  await writeFile(config, configText, { flag: "wx", mode: 0o600 });
  const report = { name, status: "running", startedAt: new Date().toISOString(), remoteExecutionAuthorized: false,
    source: frozen.evidence, cases: [], commands: [], seeds: [], snapshots: [], closures: [], fixtureBoundary:
      "Synthetic code-owned SQL metadata setup, no providers or business API qualification; every forward migration uses actual installed Wrangler CLI" };
  let commandId = 0;
  const check = () => signal?.throwIfAborted();
  async function stage(count) {
    check(); await assertSources(frozen); assert.equal(await readFile(config, "utf8"), configText);
    for (let index = 0; index < count; index++) {
      const path = join(staging, names[index]);
      try { assert.equal(await readFile(path, "utf8"), frozen.sql[index]); }
      catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(path, frozen.sql[index], { flag: "wx", mode: 0o600 }); }
    }
    assert.deepEqual((await readdir(staging)).sort(), names.slice(0, count));
  }
  async function cli(label) {
    check(); await assertSources(frozen); assert.equal(await readFile(config, "utf8"), configText);
    const base = `${String(++commandId).padStart(2, "0")}-${label}`;
    const args = [wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", persist];
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "SYSTEMROOT", "COMSPEC"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" });
    const receipt = { label, executable: process.execPath, args, startedAt: new Date().toISOString(), timeoutMs: 120000, success: false,
      stdout: `${base}.stdout.log`, stderr: `${base}.stderr.log` };
    process.stdout.write(`Current migration rehearsal ${name}: ${label}\n`);
    let child;
    const completion = new Promise(done => {
      child = execFile(process.execPath, args, { cwd: directory, env, signal, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => done({ error, stdout, stderr }));
    });
    const closed = new Promise(done => child.once("close", (exitCode, signal) => done({ exitCode, signal })));
    const { error, stdout, stderr } = await completion, originalClose = await closed;
    receipt.success = !error && originalClose.exitCode === 0 && originalClose.signal === null;
    Object.assign(receipt, originalClose, { pid: child.pid, originalCloseObserved: true });
    if (error) Object.assign(receipt, { error: error.message, errorCode: error.code });
    receipt.finishedAt = new Date().toISOString(); receipt.childSettled = true;
    await writeFile(join(directory, receipt.stdout), stdout, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, receipt.stderr), stderr, { flag: "wx", mode: 0o600 });
    report.commands.push(receipt); check(); return receipt;
  }
  async function database(work, label) {
    check(); const proxy = await getPlatformProxy({ configPath: config, persist: { path: join(persist, "v3") }, remoteBindings: false, envFiles: [] });
    try { check(); const result = await work(proxy.env.DB); check(); return result; }
    finally { await proxy.dispose(); report.closures.push({ label, proxyDisposed: true }); }
  }
  async function setup(sql, label) {
    if (!sql) return;
    await database(async db => {
      const statements = splitSql(sql); assert(statements.length > 0);
      const results = await db.batch(statements.map(sql => db.prepare(sql)));
      assert.equal(results.length, statements.length); assert(results.every(row => row.success));
      report.seeds.push({ label, sqlSha256: hash(sql), statements: statements.length, executor: "actual local D1 batch; fixture setup only" });
    }, label);
  }
  async function snapshot(label, { fault = false } = {}) {
    const value = await database(async db => {
      const observation = await observeD1Migrations(db);
      const extra = observation.schema.objects.filter(row => row.name === faultName);
      assert.equal(extra.length, fault ? 1 : 0, "Test-only fault ownership");
      if (fault) {
        assert.equal(extra[0].type, "trigger"); assert.equal(extra[0].tableName, "d1_migrations");
        assert(extra[0].sql.includes("QA current migration19 ledger fault"));
      }
      const schema = normalizeSchema({ ...observation.schema, objects: observation.schema.objects.filter(row => row.name !== faultName) });
      const tables = {};
      for (const object of schema.objects.filter(row => row.type === "table")) {
        const columns = schema.relations.find(row => row.name === object.name).columns.filter(row => row.hidden === 0).map(row => row.name);
        const originalSql = observation.schema.objects.find(row => row.type === "table" && row.name === object.name).sql;
        const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(originalSql);
        let result;
        try { result = await db.prepare(frozen.recoveryTableSnapshotSql({ name: object.name, columns, withoutRowid, local: false })).all(); }
        catch (error) { throw new Error(`Typed snapshot failed for ${object.name}`, { cause: error }); }
        assert(result.success); tables[object.name] = { columns, withoutRowid, rows: result.results.map(row => ({ rowid: row.rowid, cells: JSON.parse(row.cells) })) };
      }
      const retention = await db.prepare("SELECT * FROM blob_retention_edges").all(); assert(retention.success);
      const foreignKeyCheck = await db.prepare("PRAGMA foreign_key_check").all();
      const foreignKeys = await db.prepare("PRAGMA foreign_keys").all();
      assert(foreignKeyCheck.success && foreignKeys.success); assert.deepEqual(foreignKeyCheck.results, []);
      assert.deepEqual(foreignKeys.results, [{ foreign_keys: 1 }]);
      let globalQuickCheck;
      try {
        const result = await db.prepare("PRAGMA quick_check").all();
        assert(result.success); assert.deepEqual(result.results, [{ quick_check: "ok" }]);
        globalQuickCheck = { result: "ok" };
      } catch (error) {
        // Actual local workerd reaches its global-check statement memory limit
        // at prefix20. Do not call that query successful or omit its failure.
        // Require every physical table below and the closed-file global check.
        const detail = String(error);
        assert.match(detail, /out of memory: SQLITE_NOMEM/, "Unexpected native global quick_check failure");
        globalQuickCheck = { result: "platform-memory-limit", error: detail };
      }
      const physicalTables = observation.schema.objects.filter(row => row.type === "table").map(row => row.name).sort();
      assert(physicalTables.includes("d1_migrations") && physicalTables.includes("_cf_METADATA") && physicalTables.includes("sqlite_sequence"));
      const scopedQuickChecks = [];
      for (const table of physicalTables) {
        try {
          const result = await db.prepare(`PRAGMA quick_check(${quote(table)})`).all();
          assert(result.success); assert.deepEqual(result.results, [{ quick_check: "ok" }], `Native quick_check: ${table}`);
          scopedQuickChecks.push({ table, result: "ok" });
        } catch (error) {
          // The D1 authorizer protects exactly its own metadata table. Record
          // this boundary; the closed-file full check must cover it below.
          assert.equal(table, "_cf_METADATA", "Unexpected inaccessible physical table");
          assert.match(String(error), /not authorized: SQLITE_AUTH/);
          scopedQuickChecks.push({ table, result: "protected-engine-table", error: String(error) });
        }
      }
      return { observation, schema, tables, retention: retention.results, health: { native: { foreignKeys: true, foreignKeyViolations: 0,
        globalQuickCheck, scopedQuickChecks }, closedFile: null } };
    }, label);
    // This handle is opened only after the original proxy.dispose() completes.
    // It reads the actual persisted SQLite/WAL, not an independently rebuilt DB.
    const sqliteDirectory = join(persist, "v3/d1/miniflare-D1DatabaseObject");
    const sqliteFiles = (await readdir(sqliteDirectory)).filter(name => name.endsWith(".sqlite") && name !== "metadata.sqlite");
    assert.equal(sqliteFiles.length, 1, "One owned actual local D1 persistence database");
    const closed = new DatabaseSync(join(sqliteDirectory, sqliteFiles[0]), { readOnly: true });
    try {
      const tables = closed.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(tables, value.health.native.scopedQuickChecks.map(row => row.table), "Complete native physical-table coverage");
      assert.deepEqual(closed.prepare("PRAGMA foreign_key_check").all().map(row => ({ ...row })), []);
      assert.deepEqual(closed.prepare("PRAGMA quick_check").all().map(row => ({ ...row })), [{ quick_check: "ok" }]);
      value.health.closedFile = { mode: "actual persisted SQLite reopened read-only after proxy disposal", quickCheck: "ok", foreignKeyViolations: 0,
        physicalTables: tables, includesProtectedEngineMetadata: tables.includes("_cf_METADATA") };
    } finally { closed.close(); report.closures.push({ label: `${label}-read-only-global-health`, sqliteClosed: true }); }
    const text = json(value), filename = `${label}.private-snapshot.json`;
    await writeFile(join(directory, filename), text, { flag: "wx", mode: 0o600 });
    report.snapshots.push({ label, file: filename, sha256: hash(text), schemaSha256: schemaFingerprint(value.observation.schema),
      tables: Object.fromEntries(Object.entries(value.tables).map(([name, table]) => [name, { rows: table.rows.length, typedRowsSha256: hash(JSON.stringify(table)) }])),
      ledger: value.observation.ledger, health: value.health });
    return value;
  }
  const assertPrefix = (value, prefix) => {
    assert.deepEqual(value.schema, frozen.schemas.get(prefix), `Complete independent host schema at prefix${prefix}`);
    assert.deepEqual(value.observation.ledger.rows.map(row => row.name), names.slice(0, prefix));
  };
  const retained = (before, after) => {
    assert.deepEqual(after.observation.ledger.rows.slice(0, before.observation.ledger.rows.length), before.observation.ledger.rows, "Complete original ledger fields preserved");
    for (const [name, old] of Object.entries(before.tables)) {
      const current = after.tables[name]; assert(current, `Original table absent: ${name}`);
      assert.equal(current.withoutRowid, old.withoutRowid, `Original rowid model: ${name}`);
      const positions = old.columns.map(column => { const at = current.columns.indexOf(column); assert(at >= 0, `Original column absent: ${name}.${column}`); return at; });
      assert.deepEqual(ordered(current.rows.map(row => ({ rowid: row.rowid, cells: positions.map(at => row.cells[at]) }))), ordered(old.rows), `Original typed cells/rowids preserved: ${name}`);
    }
    if (before.observation.ledger.rows.length === 24 && after.observation.ledger.rows.length === 25) {
      assert.deepEqual(Object.keys(after.tables).sort(), Object.keys(before.tables).sort(), "Scheduler migration adds no tables");
      for (const [name, old] of Object.entries(before.tables)) {
        assert.deepEqual(after.tables[name].columns, name === "file_job_runtime_guard" ? [...old.columns, "next_queue"] : old.columns,
          `Only the installation-local scheduler cursor is added: ${name}`);
      }
    }
    assert.deepEqual(ordered(after.retention), ordered(before.retention), "Legacy retention projection preserved");
  };
  const cell = (value, table, column) => value.tables[table].rows.map(row => row.cells[value.tables[table].columns.indexOf(column)]);
  const inert = value => {
    for (const table of ["file_shadow_runtime_guard", "file_authority_runtime_guard", "file_job_runtime_guard", "system_recovery_runtime"]) {
      if (value.tables[table]) assert.deepEqual(cell(value, table, "enabled"), [{ type: "integer", value: "0" }], `${table} stays disabled`);
    }
    if (value.tables.file_job_runtime_guard?.columns.includes("next_queue")) {
      assert.deepEqual(cell(value, "file_job_runtime_guard", "next_queue"), [{ type: "text", value: "package" }], "New scheduler cursor starts with Package without enabling execution");
    }
    assert.deepEqual(cell(value, "file_authority_control", "mode"), [{ type: "text", value: "legacy" }]);
    if (value.tables.local_storage_profile_bindings) assert.equal(value.tables.local_storage_profile_bindings.rows.length, 0);
  };
  async function initial() {
    await stage(17); assert((await cli("bootstrap-prefix17")).success, "Actual Wrangler predecessor construction failed");
    await setup(await readFile(join(source, "worker/fixtures/reference-graph.sql"), "utf8") + stageSeed(17), "populated-prefix17");
    const before = await snapshot("populated-prefix17"); assertPrefix(before, 17); inert(before);
    assert(cell(before, "run_step_comments", "legacy_body").some(row => row.type === "blob" && row.value === "000102FF"));
    assert(cell(before, "run_step_comments", "legacy_body").some(row => row.type === "text" && row.value === "A\0B"));
    assert(before.tables.assets.rows.some(row => row.rowid === "9223372036854775806"));
    assert(before.tables.samples.rows.some(row => row.rowid === "-9223372036854775807"));
    assert(before.tables.storage_profiles.rows.some(row => row.rowid === "-9007199254740993"));
    assert.equal(before.tables.projects.rows.length, 2); assert.equal(before.tables.project_contents.rows.length, 1);
    report.fixtureSentinels = { nonemptyReferenceGraph: true, nulText: true, blob: true, positiveAndNegativeInt64Rowids: true,
      distinctProfilesSameObjectKey: true, pendingUpload: true, registryClaims: true, projectMarkdownAndDeletedMetadata: true };
    report.holdBoundary = "Native File holds cannot be acquired under the deliberately retained legacy authority; existing legacy asset retention projection is compared exactly";
    return before;
  }
  async function apply(prefix, before, label, options) {
    await stage(prefix); const receipt = await cli(label); assert(receipt.success, `Actual Wrangler failed: ${label}`);
    const after = await snapshot(label, options); assertPrefix(after, prefix); retained(before, after); inert(after); return after;
  }
  return { directory, report, stage, cli, setup, snapshot, assertPrefix, retained, inert, initial, apply,
    async finish(status, error) { report.status = status; report.finishedAt = new Date().toISOString(); if (error) report.error = error.stack ?? String(error);
      await writeFile(join(directory, "report.json"), json(report), { flag: "wx", mode: 0o600 }); } };
}

export async function rehearseCurrentLocalMigrations(destination, { signal } = {}) {
  assert(isAbsolute(destination) && resolve(destination) === destination, "Choose a new absolute local fixture directory");
  await mkdir(destination, { mode: 0o700 });
  const report = { version: 1, status: "running", startedAt: new Date().toISOString(), destination, remoteExecutionAuthorized: false,
    scope: "Actual installed Wrangler populated current-prefix17 to25 ladder, direct suffix and partial-prefix ledger failure/exact retry; local synthetic metadata only, no providers/Node V28/serving handover/remote migration or deployment",
    cases: [] };
  try {
    const frozen = await freezeSources(); report.source = frozen.evidence;
    for (const name of ["populated-ladder", "populated-direct", "partial-prefix-retry"]) {
      signal?.throwIfAborted(); const fixture = await createFixture(destination, name, frozen, signal); report.cases.push({ name, report: `${name}/report.json`, status: "running" });
      try {
        let current = await fixture.initial();
        if (name === "populated-ladder") {
          for (let prefix = 18; prefix <= 25; prefix++) {
            current = await fixture.apply(prefix, current, `upgrade-${prefix}`);
            const seed = stageSeed(prefix);
            if (seed) { await fixture.setup(seed, `history-at-${prefix}`); current = await fixture.snapshot(`history-at-${prefix}`); fixture.assertPrefix(current, prefix); fixture.inert(current); }
          }
          const reopened = await fixture.snapshot("reopened-current25"); assert.deepEqual(reopened, current, "Closed/reopened local database preserves all typed data and identity");
          assert((await fixture.cli("current25-no-op")).success);
          const noOp = await fixture.snapshot("after-current25-no-op"); assert.deepEqual(noOp, reopened, "Actual CLI no-op changes nothing");
          fixture.report.cases.push({ kind: "eight actual CLI suffix steps, later history fixtures, closed-owner reopen and exact no-op", passed: true });
        } else if (name === "populated-direct") {
          await fixture.apply(25, current, "direct-18-through25");
          fixture.report.cases.push({ kind: "one actual CLI applies unchanged complete suffix18..25", passed: true });
        } else {
          await fixture.setup(faultSql, "test-only-ledger-fault");
          await fixture.stage(25); const failed = await fixture.cli("expected-19-ledger-failure");
          assert.equal(failed.success, false); assert.notEqual(failed.exitCode, 0); assert.equal(failed.signal, null, "Expected SQL failure, not timeout/cancellation");
          const failureText = await readFile(join(fixture.directory, failed.stdout), "utf8") + await readFile(join(fixture.directory, failed.stderr), "utf8");
          assert.match(failureText, /QA current migration19 ledger fault/);
          const partial = await fixture.snapshot("after-failed-19", { fault: true }); fixture.assertPrefix(partial, 18); fixture.retained(current, partial); fixture.inert(partial);
          assert(!partial.tables.file_job_runtime_guard && !partial.tables.file_migration_jobs, "Failed19's actual preceding DDL rolled back");
          await fixture.setup(`DROP TRIGGER ${faultName};`, "remove-only-test-fault");
          const restart = await fixture.snapshot("restart-at-18"); fixture.assertPrefix(restart, 18);
          await fixture.apply(25, restart, "identical-19-through25-retry");
          fixture.report.cases.push({ kind: "actual ledger fault after19 DDL, committed18 retained, failed19 rolled back, unchanged19..25 retry", passed: true });
        }
        await fixture.finish("passed"); report.cases.at(-1).status = "passed";
      } catch (error) { await fixture.finish("failed", error); report.cases.at(-1).status = "failed"; throw error; }
    }
    report.status = "passed"; return report;
  } catch (error) { report.status = "failed"; report.error = error.stack ?? String(error); throw error; }
  finally { report.finishedAt = new Date().toISOString(); await writeFile(join(destination, "report.json"), json(report), { flag: "wx", mode: 0o600 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.length === 4 && process.argv[2] === "--destination", "Usage: node scripts/rehearse-current-local-migrations.mjs --destination /tmp/NEW_OUTPUT");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Original current-chain qualification was interrupted"));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const report = await rehearseCurrentLocalMigrations(resolve(process.argv[3]), { signal: controller.signal });
    process.stdout.write(json({ status: report.status, report: join(report.destination, "report.json"), cases: report.cases }));
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === "true") {
      const detail = String(error.stack ?? error).slice(0, 12000).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
      process.stdout.write(`::error title=Populated current-chain Wrangler failure::${detail}\n`);
    }
    process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1;
  }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
