import { randomUUID } from "node:crypto";
import { SqlFileJobRepository, type JobSqlDatabase, type JobSqlStatement } from "../../../worker/files/jobs/sql-repository";
import type { FileJobRepository, JobClaim } from "../../../worker/files/jobs/types";
import { checkedSafeInteger, createSqliteBatchAdmission, runSqliteAdmittedBatch,
  type SqliteBatchAdmission, type SqliteRow, type SqliteStatement } from "../../sqlite";
import { localJobPrincipalId, ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority, type JobPrincipalOwner } from "./principal-authority";
import { nodeFileJobExecutionChecks, type NodeFileJobExecutionAdmission } from "./execution-admission";

type Policy = Readonly<{ kind: "owner" }> | Readonly<{ kind: "principal"; actor: string; jobId?: string }>
  | Readonly<{ kind: "maintenance"; incarnation: string; jobId?: string }>;
const OWNER: Policy = Object.freeze({ kind: "owner" });
const runtime = `EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg
  ON fg.singleton=g.singleton AND fg.enabled=1 JOIN file_authority_control fc ON fc.singleton=g.singleton
  AND fc.mode='active' WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?)`;
function mutationAdmission(owner: JobPrincipalOwner, policy: Policy,
  execution?: Readonly<{ token: NodeFileJobExecutionAdmission; authority: InstalledJobPrincipalAuthority }>): SqliteBatchAdmission {
  const i = owner.installation;
  const parts = [`EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
    AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)`];
  const values: (string | number | bigint)[] = [i.installationId, i.catalogId, i.checkpointId, i.schemaSha256, i.createdAt];
  parts.push("EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)");
  values.push(owner.identityInstallation.bootstrapPrincipalId, owner.identityInstallation.initializedAt);
  if (policy.kind === "principal") {
    const id = localJobPrincipalId(policy.actor); if (!id) throw new Error("Current local job administrator is unavailable");
    parts.push(`EXISTS(SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
      WHERE a.principal_id=? AND a.enabled=1 AND EXISTS(SELECT 1 FROM local_identity_installation
        WHERE singleton=1 AND catalog_id='local-identity-v1'))`); values.push(id);
    if (policy.jobId !== undefined) {
      parts.push("EXISTS(SELECT 1 FROM file_migration_jobs WHERE id=? AND actor=?)"); values.push(policy.jobId, policy.actor);
    }
  } else if (policy.kind === "maintenance") {
    parts.push(runtime); values.push(policy.incarnation);
    if (policy.jobId !== undefined) {
      parts.push("EXISTS(SELECT 1 FROM file_job_cleanup_grants WHERE job_id=? AND runtime_incarnation=?)");
      values.push(policy.jobId, policy.incarnation);
    }
  }
  const statement = owner.database.prepare(`SELECT CASE WHEN ${parts.join(" AND ")} THEN 1 ELSE 0 END AS admitted`).bind(...values);
  return createSqliteBatchAdmission(owner.database, [
    ...(execution ? nodeFileJobExecutionChecks(execution.token, execution.authority, policy.kind === "owner") : []),
    { statement, rejection: new Error("Owned Node job mutation unavailable") }]);
}
/** This view is private to one mature repository operation. No SQL/name
 * inspection selects policy. Final guards and original mutations execute in
 * ONE real core BEGIN IMMEDIATE/COMMIT, without await inside that transaction. */
function operationSql(owner: JobPrincipalOwner, selectPolicy: () => Policy,
  execution?: Readonly<{ token: NodeFileJobExecutionAdmission; authority: InstalledJobPrincipalAuthority }>): JobSqlDatabase {
  const core = owner.database, statements = new WeakMap<JobSqlStatement, SqliteStatement>();
  // Same checked Number compatibility as the existing genuine Node job view;
  // typed core cells are never rounded to satisfy a caller's generic row type.
  const safeRow = (row: SqliteRow) => Object.fromEntries(Object.entries(row).map(([key, cell]) =>
    [key, typeof cell === "bigint" ? checkedSafeInteger(cell, `Column ${key}`) : cell]));
  const execute = async (native: SqliteStatement) => {
    owner.assertCurrent(); const admission = mutationAdmission(owner, selectPolicy(), execution);
    owner.assertCurrent(); const results = await runSqliteAdmittedBatch(core, [native], admission); owner.assertCurrent();
    const result = results[0]; if (!result) throw new Error("Owned Node job result is unavailable"); return result;
  };
  const wrap = (native: SqliteStatement): JobSqlStatement => {
    const statement: JobSqlStatement = {
      bind(...values) { owner.assertCurrent(); return wrap(native.bind(...values)); },
      async first<T>() {
        // first() includes an existing UPDATE ... RETURNING cleanup command.
        // Guard every operation without parsing its SQL to guess write intent.
        const row = (await execute(native)).results[0]; return row === undefined ? null : safeRow(row) as T;
      },
      async all<T>() { return { results: (await execute(native)).results.map(safeRow) as T[] }; },
      run() { return execute(native); },
    };
    statements.set(statement, native); return statement;
  };
  const view: JobSqlDatabase = {
    prepare(text) { owner.assertCurrent(); return wrap(core.prepare(text)); },
    async batch(items) {
      const selected = items.map(item => { const native = statements.get(item);
        if (!native) throw new Error("Foreign owned Node job statement"); return native; });
      owner.assertCurrent(); const admission = mutationAdmission(owner, selectPolicy(), execution);
      owner.assertCurrent(); const results = await runSqliteAdmittedBatch(core, selected, admission); owner.assertCurrent(); return results;
    },
    primary() { owner.assertCurrent(); return view; },
  };
  return view;
}
function unavailableHttp(): never { throw new Error("Node File job HTTP admission is not composed"); }

/** Background-only port. Existing HTTP accept/control/cleanup methods remain
 * CLOSED until a genuine original Request/session owner is composed. Provider
 * opening, executor enablement and source-maintenance admission are separate. */
export function createOwnedNodeFileJobPort(options: {
  authority: InstalledJobPrincipalAuthority; incarnation: string;
  executionAdmission?: NodeFileJobExecutionAdmission;
  now?: () => Date; randomId?: () => string;
}): {
  repository: FileJobRepository;
  authorizeAdministrator(actor: string): boolean;
  authorizeSystemCleanup(): boolean;
} {
  const { authority, incarnation } = options, now = options.now ?? (() => new Date()), id = options.randomId ?? randomUUID;
  const owner = ownedJobPrincipalAuthority(authority), authorize = authority.authorizeAdministrator.bind(authority);
  if (typeof incarnation !== "string" || !incarnation || incarnation.length > 128) throw new Error("Node job incarnation is unavailable");
  const repo = (policy: Policy | (() => Policy) = OWNER) => new SqlFileJobRepository(operationSql(owner,
    typeof policy === "function" ? policy : () => policy,
    options.executionAdmission ? Object.freeze({ token: options.executionAdmission, authority }) : undefined), now, id);
  const owned = repo();
  const sameIncarnation = (value: string) => { owner.assertCurrent(); if (value !== incarnation) throw new Error("Node job incarnation differs"); };
  const principal = (claim: JobClaim) => { sameIncarnation(claim.runtime_incarnation);
    return repo(Object.freeze({ kind: "principal", actor: claim.actor, jobId: claim.id })); };
  const maintenance = (jobId?: string) => repo(Object.freeze({ kind: "maintenance", incarnation, jobId }));
  const repository: FileJobRepository = {
    plan: input => owned.plan(input), accept: async () => unavailableHttp(), requestReceipt: async () => unavailableHttp(),
    control: async () => unavailableHttp(), requestCleanup: async () => unavailableHttp(),
    async claim(value, token, restrict) {
      sameIncarnation(value);
      // This lexical policy belongs ONLY to this one claim call; concurrent
      // jobs never share it. Mature repository admission supplies the exact
      // persisted candidate actor immediately before its run(). Revoked
      // candidate pause uses owner-only policy; successful claim rechecks its
      // actor inside the real update transaction.
      let selected: Policy = OWNER;
      return repo(() => selected).claim(value, token, actor => {
        if (!authorize(actor) || restrict(actor) !== true) { selected = OWNER; return false; }
        selected = Object.freeze({ kind: "principal", actor }); return true;
      });
    },
    owns: claim => owned.owns(claim), nextItem: claim => owned.nextItem(claim), attempt: item => owned.attempt(item),
    stage: (claim, item) => principal(claim).stage(claim, item),
    startWrite: (claim, attempt) => principal(claim).startWrite(claim, attempt),
    verify: (claim, item, attempt) => principal(claim).verify(claim, item, attempt),
    cutover: (claim, item, attempt) => principal(claim).cutover(claim, item, attempt),
    // Positive original I/O evidence and safe revocation bookkeeping must not
    // require the administrator to remain granted after the provider started.
    observeSettled: attempt => owned.observeSettled(attempt),
    fail: (claim, item, attempt, reason) => owned.fail(claim, item, attempt, reason),
    pause: (claim, reason) => owned.pause(claim, reason), release: claim => owned.release(claim),
    heartbeat: value => { sameIncarnation(value); return owned.heartbeat(value); },
    status: job => owned.status(job), list: () => owned.list(), executorStatus: () => owned.executorStatus(),
    inventory: input => owned.inventory(input), items: (job, cursor) => owned.items(job, cursor),
    runtimeEnabled: value => { sameIncarnation(value); return owned.runtimeEnabled(value); },
    cleanupGranted: (job, value) => { sameIncarnation(value); return owned.cleanupGranted(job, value); },
    cleanupArtifact: value => { sameIncarnation(value); return maintenance().cleanupArtifact(value); },
    cleanupCopy: value => { sameIncarnation(value); return maintenance().cleanupCopy(value); },
    releaseArtifact: (artifact, value) => { sameIncarnation(value); return maintenance(artifact.job_id).releaseArtifact(artifact, value); },
    releaseCleanup: (copy, value) => { sameIncarnation(value); return maintenance(copy.job_id).releaseCleanup(copy, value); },
    // Disposal-completed read-hold bookkeeping remains owner-only, including
    // after revocation or disablement, and adds no physical settlement proof.
    releaseVerificationHold: copy => owned.releaseVerificationHold(copy),
    releaseUnneededSource: value => { sameIncarnation(value); return maintenance().releaseUnneededSource(value); },
  };
  return Object.freeze({ repository, authorizeAdministrator: authorize,
    authorizeSystemCleanup() {
      try { owner.assertCurrent(); const row = owner.nativeDatabase.prepare(`SELECT 1 WHERE ${runtime}`).get(incarnation);
        owner.assertCurrent(); return !!row; } catch { return false; }
    },
  });
}
