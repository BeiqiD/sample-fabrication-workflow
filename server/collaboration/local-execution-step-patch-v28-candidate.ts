import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import type { UpdateRunStepInput } from "../../shared/types";
import { updateExecutionStepWithDatabase } from "../../worker/execution/file-metadata-service";
import type { ExecutionFileMetadataDatabase, ExecutionFileMetadataStatement } from "../../worker/execution/file-metadata-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const executionPatchBrand: unique symbol;
export interface ExecutionStepPatchV28Request {
  readonly kind: "current-asset-free-execution-step-patch-v28/1";
  readonly [executionPatchBrand]: true;
}
type Scope = Readonly<{ sampleId: string; runId: string; stepId: string }>;
type Captured = Readonly<{ request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  scope: Scope; actor: string; tokenHash: string; credentialRevision: bigint; sessionCreatedAt: bigint }>;
const unavailable = () => new HTTPException(503, { message: "Current execution metadata is unavailable" });
const mediaUnavailable = () => new HTTPException(503, { message: "Execution attachment permissions are not installed" });
const denied = () => new HTTPException(403, { message: "Current explicit Sample operate permission is required" });
const hidden = () => new HTTPException(404, { message: "Run step not found" });
const changed = () => new HTTPException(409, { message: "This step changed elsewhere. Reload before saving." });
const bad = () => new HTTPException(400, { message: "Valid editable step fields and expectedUpdatedAt are required" });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const STEP_READ_SQL = "SELECT COALESCE(rs.title, sd.name) AS title, rs.status, rs.notes,\n            COALESCE(rs.tool_name, sd.tool_name) AS tool_name,\n            COALESCE(rs.parameters_text, sd.parameters_text) AS parameters_text,\n            COALESCE(rs.comments_text, sd.comments_text) AS comments_text,\n            sd.name AS planned_title, sd.tool_name AS planned_tool_name,\n            sd.parameters_text AS planned_parameters_text, sd.comments_text AS planned_comments_text,\n            rs.deviation_note, rs.origin, rs.updated_at\n     FROM run_steps rs JOIN runs r ON r.id = rs.run_id\n     JOIN samples s ON s.id = r.sample_id\n     LEFT JOIN step_definitions sd ON sd.hash = rs.definition_hash\n     WHERE rs.id = ? AND r.id = ? AND r.sample_id = ?\n       AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL";
const STEP_UPDATE_SQL = "UPDATE run_steps SET status = ?, title = ?, tool_name = ?, parameters_text = ?, comments_text = ?,\n       deviation_note = ?, notes = ?, actualized_at = COALESCE(actualized_at, ?), updated_by = ?, last_mutation_id = ?, updated_at = ?\n       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL\n         AND EXISTS (\n           SELECT 1 FROM runs\n           JOIN samples s ON s.id = runs.sample_id\n           WHERE runs.id = run_steps.run_id\n             AND s.deleted_at IS NULL AND runs.deleted_at IS NULL\n         )";
const EVENT_INSERT_SQL = "INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)\n       SELECT ?, r.sample_id, 'step', ?, ?, ?, ? FROM run_steps rs JOIN runs r ON r.id = rs.run_id\n       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?\n         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL";
const SAMPLE_UPDATE_SQL = "UPDATE samples SET updated_by = ?, updated_at = ?\n     WHERE id = ? AND deleted_at IS NULL AND EXISTS (\n       SELECT 1 FROM run_steps rs JOIN runs r ON r.id = rs.run_id\n       WHERE rs.id = ? AND r.id = ? AND r.sample_id = ? AND rs.last_mutation_id = ?\n         AND r.deleted_at IS NULL AND rs.deleted_at IS NULL\n     )";

/** New named-Sample V28 owner only. It calls the whole original neutral
 * validator/algorithm and permits exactly its absent-asset three-mutation path.
 * No physical provider, File purpose, administrator or creation flag grants it.
 * The unchanged V26 Local owner and every other existing Group owner remain.
 * The stopped host retains the original body/work and discards this factory
 * only after the cached original operation settles, before sole native ACK. */
export function createLocalExecutionStepPatchV28Candidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
}) {
  const { database, nativeDatabase, admission, writerLease, authentication } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (installation.checkpointId !== "portable-runtime/v28") throw unavailable();
  const control = nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if (control?.schema_version !== 2 || !["disabled", "enabled"].includes(control.enforcement as string)
    || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });

  const requests = new WeakMap<ExecutionStepPatchV28Request, Captured>();
  const work = new WeakMap<ExecutionStepPatchV28Request, Promise<{ ok: boolean }>>();
  const pending = new Set<Promise<{ ok: boolean }>>(); let active = true;
  // Table names are closed code-owned constants. Actual complete column names
  // are observed only after genuine installed V28 admission, not request input.
  // SQL JSON remains an exact native string: no bigint-to-Number snapshot loss.
  function completeRow(table: "run_steps" | "runs" | "samples" | "step_definitions", alias: "rs" | "r" | "s" | "sd") {
    const rows = nativeDatabase.prepare(`PRAGMA table_info("${table}")`).all();
    if (!rows.length || rows.some(row => typeof row.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(row.name))) throw unavailable();
    const names = rows.map(row => String(row.name));
    if (new Set(names).size !== names.length) throw unavailable();
    return `json_array(${names.map(name => `${alias}."${name}"`).join(",")})`;
  }
  const witnessSql = `SELECT json_object('step',${completeRow("run_steps","rs")},'run',${completeRow("runs","r")},
    'sample',${completeRow("samples","s")},'definition',${completeRow("step_definitions","sd")}) state
    FROM run_steps rs JOIN runs r ON r.id=rs.run_id JOIN samples s ON s.id=r.sample_id
    LEFT JOIN step_definitions sd ON sd.hash=rs.definition_hash
    WHERE rs.id=? AND r.id=? AND s.id=? AND rs.deleted_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL`;
  function selected(request: Request, token: ExecutionStepPatchV28Request) {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function guards(owner: Captured, witness?: string, includeSource = true) {
    const checks = [
      { statement: database.prepare(`SELECT 1 admitted FROM local_sessions session JOIN local_accounts account ON account.principal_id=session.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE session.token_hash=? AND account.principal_id=? AND account.enabled=1 AND session.credential_revision=account.credential_revision
          AND account.credential_revision=? AND session.created_at=? AND session.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=session.last_seen_at AND clock.now<session.absolute_expires_at AND clock.now<session.last_seen_at+? LIMIT 1`)
        .bind(owner.tokenHash, owner.facts.subject, owner.credentialRevision, owner.sessionCreatedAt, policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId,installation.catalogId,installation.checkpointId,installation.schemaSha256,installation.createdAt,bootstrapPrincipalId,initializedAt),rejection:unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE ${memberWhere} LIMIT 1`).bind(localIssuer,owner.facts.subject),rejection:denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode IN('legacy','active'))`),rejection:unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_resources resource
        JOIN collaboration_grants grant_row ON grant_row.root_kind=resource.root_kind AND grant_row.root_id=resource.root_id
        JOIN collaboration_identities i ON i.member_id=grant_row.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE resource.root_kind='sample' AND resource.root_id=? AND ${memberWhere}
          AND grant_row.enabled=1 AND grant_row.capability IN('operate','edit','manage') LIMIT 1`)
        .bind(owner.scope.sampleId,localIssuer,owner.facts.subject),rejection:denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM run_steps step JOIN runs run ON run.id=step.run_id JOIN samples sample ON sample.id=run.sample_id
        WHERE step.id=? AND run.id=? AND sample.id=? AND step.deleted_at IS NULL AND run.deleted_at IS NULL AND sample.deleted_at IS NULL`)
        .bind(owner.scope.stepId,owner.scope.runId,owner.scope.sampleId),rejection:hidden() },
      { statement: witness === undefined ? database.prepare(`SELECT 1 admitted WHERE (${witnessSql}) IS NOT NULL`)
        .bind(owner.scope.stepId,owner.scope.runId,owner.scope.sampleId) : database.prepare(`SELECT 1 admitted WHERE (${witnessSql}) IS ?`)
        .bind(owner.scope.stepId,owner.scope.runId,owner.scope.sampleId,witness),rejection:changed() },
    ];
    // Capture authenticates the named Sample before body parsing. The original
    // full body validation still precedes actual Step404/CAS source selection.
    return createSqliteBatchAdmission(database,includeSource?checks:checks.slice(0,5));
    // Native reads and original atomic mutations use all seven; core max8 stays. 
  }
  async function capture(request: Request, scope: Scope): Promise<ExecutionStepPatchV28Request> {
    if (!active || request.method !== "PATCH" || request.bodyUsed || !scope
      || Object.keys(scope).sort().join(",") !== "runId,sampleId,stepId"
      || ![scope.sampleId,scope.runId,scope.stepId].every(value => canonicalIdentityText(value,256))) throw denied();
    const copied = Object.freeze({ sampleId:scope.sampleId,runId:scope.runId,stepId:scope.stepId });
    const url = new URL(request.url);
    if (url.pathname !== `/api/samples/${encodeURIComponent(copied.sampleId)}/runs/${encodeURIComponent(copied.runId)}/steps/${encodeURIComponent(copied.stepId)}`
      || url.search || url.hash) throw denied();
    const tokenHash=auth.captureSessionDigest(request),subject=await issuer.issue(request),facts=issuer.read(request,subject);
    if (facts.provider!=="local" || facts.issuer!==localIssuer) throw denied();
    const actor=`local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request,actor).tokenHash!==tokenHash) throw denied();
    const statement=nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true);const row=statement.get(tokenHash,facts.subject);issuer.read(request,subject);
    if (typeof row?.credential_revision!=="bigint" || typeof row.created_at!=="bigint") throw denied();
    const token=Object.freeze({kind:"current-asset-free-execution-step-patch-v28/1" as const}) as ExecutionStepPatchV28Request;
    const owner=Object.freeze({request,subject,facts,scope:copied,actor,tokenHash,credentialRevision:row.credential_revision,sessionCreatedAt:row.created_at});
    await runSqliteAdmittedBatch(database,[],guards(owner,undefined,false));requests.set(token,owner);return token;
  }
  function patch(request: Request,token: ExecutionStepPatchV28Request,readBody:()=>Promise<unknown>):Promise<{ok:boolean}> {
    const owner=selected(request,token),previous=work.get(token);
    if(previous)return previous; // Same original work/ACK, never a new body read or replay.
    const original=Promise.resolve().then(async()=>{
      let witness:string|undefined,mutated=false;
      let workFailed=false,workError:unknown,result:{ok:boolean}|undefined;
      try {
      const parsed=await readBody();selected(request,token);
      if (!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw bad();
      const body=Object.freeze({...parsed}); // Capture exact scalar input before subsequent SQL awaits.
      interface Statement extends ExecutionFileMetadataStatement<Statement> {}
      type Issued=Readonly<{native:SqliteStatement;sql:string;values:readonly unknown[]}>;
      const issued=new WeakMap<Statement,Issued>();
      const allowed=new Map([[STEP_READ_SQL,3],[STEP_UPDATE_SQL,13],[EVENT_INSERT_SQL,9],[SAMPLE_UPDATE_SQL,7]]);
      function wrap(native:SqliteStatement,sql:string,values:readonly unknown[]=[]):Statement {
        const view:Statement=Object.freeze({
          bind(...input:unknown[]) {selected(request,token);if(input.length!==allowed.get(sql))throw denied();
            const copied=Object.freeze(input.map(configurationSqlCell));return wrap(native.bind(...copied),sql,copied);},
          async first<Row>() {
            selected(request,token);if(sql!==STEP_READ_SQL || values.length!==3 || mutated)throw denied();
            if(values[0]!==owner.scope.stepId || values[1]!==owner.scope.runId || values[2]!==owner.scope.sampleId)throw denied();
            const rows=await runSqliteAdmittedBatch(database,[native,database.prepare(witnessSql).bind(...values)],guards(owner,witness));
            if(rows.length!==2 || rows[1]?.results.length!==1 || typeof rows[1].results[0]?.state!=="string")throw changed();
            witness=rows[1].results[0].state;selected(request,token);
            const row=rows[0]?.results[0];return row===undefined?null:configurationSqlRow(row) as Row;
          },
          async all<Row>():Promise<{results:Row[]}> {throw denied();},
        });issued.set(view,Object.freeze({native,sql,values}));return view;
      }
      const port:ExecutionFileMetadataDatabase<Statement>=Object.freeze({
        prepare(sql:string){selected(request,token);if(!allowed.has(sql))throw denied();return wrap(database.prepare(sql),sql);},
        primary(){selected(request,token);return port;},
        // The complete original asset-input validator throws400 first for
        // malformed selectors. A valid selector reaches this fixed rejection
        // before any File/asset lookup, provider or purpose issuance.
        async authorityMode():Promise<never>{throw mediaUnavailable();},
        async atomicBatch(items:Statement[]) {
          selected(request,token);if(mutated || witness===undefined || items.length!==3)throw denied();
          const originals=items.map(item=>{const result=issued.get(item);if(!result)throw denied();return result;});
          if(originals.some((value,index)=>value.sql!==[STEP_UPDATE_SQL,EVENT_INSERT_SQL,SAMPLE_UPDATE_SQL][index]
            || value.values.length!==allowed.get(value.sql)))throw denied();
          const rows=await runSqliteAdmittedBatch(database,originals.map(value=>value.native),guards(owner,witness));mutated=true;
          if(rows.length!==3)throw new Error("Original three-statement Execution acknowledgement is incomplete");
          return rows.map(value=>({meta:{changes:configurationSqlInteger(value.meta.directChanges,"ExecutionPatch.directChanges")}}));
        },
      });
      // This is the same JSON-to-original-service type boundary as Worker/V26;
      // the complete original validators above all actual SQL remain unchanged.
      // It supplies no actor, source, File or admission authority.
      result=await updateExecutionStepWithDatabase(port,owner.scope.sampleId,owner.scope.runId,owner.scope.stepId,body as UpdateRunStepInput,owner.actor);
      } catch(error) {workFailed=true;workError=error;}
      // The original work outcome and this fresh native decision are independent.
      // Before source selection, keep five live purpose checks so original
      // body400/media503 still precede Step404. With an actual source witness,
      // retain all seven and its exact equality until our own admitted commit.
      // Only that accepted mutation invalidates its own old source equality;
      // current path/nondeleted/source existence and all live rights remain.
      let finalFailed=false,finalError:unknown;
      try {
        selected(request,token);
        await runSqliteAdmittedBatch(database,[],guards(owner,mutated?undefined:witness,witness!==undefined||mutated));
        selected(request,token);
      } catch(error) {finalFailed=true;finalError=error;}
      if(workFailed&&finalFailed)throw new AggregateError([workError,finalError],"Original Execution work and final current authority both failed");
      if(workFailed)throw workError; // Preserve the exact original, including falsy causes.
      if(finalFailed)throw finalError;
      if(result===undefined)throw new Error("Original Execution result acknowledgement is unavailable");
      return result;
    });
    work.set(token,original);pending.add(original);
    void original.then(()=>pending.delete(original),()=>pending.delete(original));return original;
  }
  return Object.freeze({capture,patch,discard(){if(pending.size)throw new Error("Original Execution work acknowledgement remains outstanding");active=false;}});
}
