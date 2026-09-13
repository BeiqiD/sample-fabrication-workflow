import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { D1_MIGRATION_OBSERVATION_SQL as SQL, observeD1Migrations } from "./d1-migration-observer.mjs";
import { migrationSqlHash, normalizeSchema, schemaFingerprint } from "./d1-migration-plan.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const USAGE = "Usage: node scripts/observe-remote-d1-migrations.mjs --account-id <32 hex characters> --database-id <UUID> --output <new private JSON file>\nCredential: CLOUDFLARE_API_TOKEN in the invoking environment (D1 Read). No config or credential files are loaded.\n";

class ObservationError extends Error {
  constructor(code) { super(`Remote D1 observation rejected: ${code}`); }
}
const reject = (code) => { throw new ObservationError(code); };
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function targetOptions(options) {
  if (!isObject(options) || Object.keys(options).some((key) => !["accountId", "databaseId"].includes(key))) reject("invalid target options");
  const { accountId, databaseId } = options;
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) reject("invalid account identifier");
  if (typeof databaseId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId)) reject("invalid database identifier");
  return { accountId: accountId.toLowerCase(), databaseId: databaseId.toLowerCase() };
}

async function responseJson(response, signal) {
  if (response.status !== 200 || response.redirected) reject("unsuccessful HTTP response");
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get("content-type") ?? "")) reject("unexpected response type");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) reject("response body limit");
  if (!response.body) reject("missing response body");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) reject("response body limit");
      chunks.push(value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { reject("invalid response JSON"); }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

function queryRows(envelope) {
  if (!isObject(envelope) || envelope.success !== true || !Array.isArray(envelope.errors) || envelope.errors.length
    || !Array.isArray(envelope.messages) || !Array.isArray(envelope.result) || envelope.result.length !== 1
    || "result_info" in envelope) reject("invalid query envelope or cardinality");
  const result = envelope.result[0];
  if (!isObject(result) || result.success !== true || !Array.isArray(result.results)
    || result.results.some((row) => !isObject(row)) || "error" in result
    || ("errors" in result && (!Array.isArray(result.errors) || result.errors.length))) reject("unsuccessful or malformed query result");
  if ("meta" in result && (!isObject(result.meta)
    || ("changed_db" in result.meta && result.meta.changed_db !== false)
    || ("rows_written" in result.meta && result.meta.rows_written !== 0))) reject("unexpected database write metadata");
  return result.results;
}

/** Read only fixed observation statements. Injectable I/O is for offline tests;
 * the CLI always uses native fetch and only the invoking environment's token. */
export async function observeRemoteD1Migrations(options, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const target = targetOptions(options);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) reject("invalid timeout");
  const token = env?.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || token.length < 1 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) reject("missing or invalid environment token");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`;
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const requests = [];
  let timer;
  const deadline = new Promise((_, rejectDeadline) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new ObservationError("observation timeout"));
    }, timeoutMs);
  });
  const query = async (sql, role) => {
    controller.signal.throwIfAborted();
    const requestStartedAt = new Date().toISOString();
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sql }),
    });
    const results = queryRows(await responseJson(response, controller.signal));
    requests.push({ role, statementCount: 1, startedAt: requestStartedAt, completedAt: new Date().toISOString() });
    return { success: true, results };
  };
  // This private adapter accepts only the existing observer's exact sequence.
  // It is intentionally not an exported general-purpose REST/SQL client.
  const prepared = new WeakMap();
  const database = {
    prepare(sql) {
      if (![SQL.ledgerProbe, SQL.schema, SQL.ledger].includes(sql)) reject("unsupported observation statement");
      const statement = { all: () => {
        if (sql !== SQL.ledgerProbe) reject("unsupported standalone statement");
        return query(sql, "ledger-probe");
      } };
      prepared.set(statement, sql);
      return statement;
    },
    async batch(statements) {
      if (!Array.isArray(statements) || ![1, 2].includes(statements.length)
        || prepared.get(statements[0]) !== SQL.schema
        || (statements.length === 2 && prepared.get(statements[1]) !== SQL.ledger)) reject("unsupported observation batch");
      if (statements.length === 1) return [await query(SQL.schema, "snapshot")];
      const result = await query(SQL.schemaAndLedger, "snapshot");
      if (result.results.length !== 1 || typeof result.results[0].ledger_json !== "string") reject("invalid combined observation");
      let ledger;
      try { ledger = JSON.parse(result.results[0].ledger_json); }
      catch { reject("invalid ledger JSON"); }
      return [
        { success: true, results: [{ schema_json: result.results[0].schema_json }] },
        { success: true, results: ledger },
      ];
    },
  };
  try {
    const observation = await Promise.race([observeD1Migrations(database), deadline]);
    const artifact = {
      version: 1, kind: "remote-d1-migration-observation", target,
      startedAt, completedAt: new Date().toISOString(), requests,
      consistency: "schema-and-ledger-in-one-sql-statement",
      executionAuthorized: false,
      observedSchemaHash: schemaFingerprint(observation.schema),
      observationHash: migrationSqlHash(JSON.stringify({ schema: normalizeSchema(observation.schema), ledger: observation.ledger })),
      observation,
    };
    return { ...artifact, artifactHash: migrationSqlHash(JSON.stringify(artifact)) };
  } catch (error) {
    // Provider bodies, SQL identifiers and network exception messages can contain
    // sensitive material. Only this module's fixed diagnostics may escape.
    if (error instanceof ObservationError) throw error;
    reject(controller.signal.aborted ? "observation timeout" : "query or observation validation failed");
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Reserve a NEW file before any request. Never overwrite existing output,
 * follow a final-component symlink, or print the observation/credential. */
export async function writeRemoteD1Observation(options, output, dependencies) {
  targetOptions(options);
  if (typeof output !== "string" || !output || output.includes("\0")) reject("invalid output path");
  const path = resolve(output);
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { reject("output must be a new writable file"); }
  let identity;
  try {
    identity = await handle.stat();
    const artifact = await observeRemoteD1Migrations(options, dependencies);
    await handle.writeFile(JSON.stringify(artifact, null, 2) + "\n", "utf8");
    await handle.sync();
    const current = await lstat(path);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino
      || (process.platform !== "win32" && (current.mode & 0o077) !== 0)) reject("private output was replaced or exposed");
    return artifact;
  } catch (error) {
    // Remove only the file we exclusively created, even if the output pathname
    // was replaced while the request was pending.
    const current = await lstat(path).catch(() => null);
    if (identity && current?.dev === identity.dev && current?.ino === identity.ino) await unlink(path).catch(() => {});
    if (error instanceof ObservationError) throw error;
    reject("unable to save private observation");
  } finally { await handle.close().catch(() => reject("unable to close private output")); }
}

export async function runRemoteObservationCli(argv, dependencies) {
  if (argv.length === 1 && argv[0] === "--help") return USAGE;
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--account-id", "--database-id", "--output"].includes(flag) || flag in values
      || typeof argv[index + 1] !== "string" || !argv[index + 1] || argv[index + 1].startsWith("--")) reject("invalid or duplicate CLI argument");
    values[flag] = argv[index + 1];
  }
  await writeRemoteD1Observation({ accountId: values["--account-id"], databaseId: values["--database-id"] }, values["--output"], dependencies);
  return "Private D1 observation saved. Migration execution remains unauthorized.\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(await runRemoteObservationCli(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write((error instanceof ObservationError ? error.message : "Remote D1 observation failed") + "\n");
    process.exitCode = 1;
  }
}
