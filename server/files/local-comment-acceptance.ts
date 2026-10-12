import { HTTPException } from "hono/http-exception";
import type { FilePurpose } from "../../shared/contracts/files";
import { validSubmissionId } from "../../shared/contracts/comment-submissions";
import { safeAttachmentObjectName } from "../../worker/attachment-object-name";
import { verifyOwnedAcceptedResultFile } from "../../worker/files/accepted-result-reader-core";
import { stageAuthorityCandidate, type AuthorityCandidateOwner } from "../../worker/files/authority-candidates-core";
import { writeAuthorityCandidate } from "../../worker/files/authority-publication-core";
import { prepareNativeAssetAliasInsert } from "../../worker/files/native-asset-alias-core";
import { verifyByteStream } from "../../worker/files/byte-verification";
import { readSqlStorageRoleDefaults } from "../../worker/files/storage-role-defaults-core";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { configurationSqlCell, configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import type { FileAuthoritySqlDatabase, FileAuthoritySqlStatement, FileAuthoritySqlRow } from "../../worker/runtime/file-authority-sql";
import type { CommentAcceptanceDatabase, CommentAcceptancePorts, CommentAcceptanceStatement } from "../../worker/uploads/comment-acceptance-ports";
import { acceptedComment, createAcceptedComment, uploadAcceptedCommentItem, finalizeAcceptedComment,
  cancelAcceptedComment, removeAcceptedCommentItem, CommentAcceptanceUnavailableError } from "../../worker/uploads/comment-acceptance-service";
import type { ReviewedInstallationAdmission } from "../migrations";
import { captureLocalVolumeProfileAuthority, prepareLocalVolumeProfileAuthorityFence,
  type LocalVolumeProfileOpening, type LocalVolumeProfileAuthority } from "../storage/local-volume-profile-opening";
import { prepareLocalVolumeRoleSelectionFence } from "../storage/local-volume-role-policy";
import { nodeSha256 } from "../storage/node-sha256";
import { createLocalUploadExecution, assertLocalUploadExecutionOwner, assertLocalUploadExecutionRequestOwner, type LocalUploadExecution } from "./local-upload-execution";
import { ownedCommentAcceptanceBody, readOwnedCommentAcceptanceBody } from "./owned-comment-acceptance-body";

interface Statement extends CommentAcceptanceStatement<Statement> {}
type Operation = "create" | "state" | "uploadItem" | "finalize" | "cancel" | "removeItem";

/** Unmounted complete ordinary V26 system-scope canonical Comment owner. The
 * exact authenticated Request binds one original operation before body work.
 * Its same installed Native/core/physical lease, current session, File runtime,
 * recovery owner and both actual Local roles fence every real BEGIN and I/O.
 * Existing all-target Sample→Run→Step, author, replay/CAS, receipt/lifecycle and
 * final snapshot predicates stay in the complete mature algorithms. No Sample
 * grant, administrator flag, Group advisory result, archive proof or fake Env
 * issues permission here. Enabled Group/V28 requires a separate issuer.
 *
 * The composer must retain settled/dispose independently of Response and drain
 * this whole original operation before closing its sole Native/physical owner.
 * The factory never installs profiles, enables File, mounts routes or exports
 * its SQL/provider ports. */
function captureCanonicalCommentOperation(request: Request) {
  const pathname = new URL(request.url).pathname;
  const collection = pathname === "/api/comment-submissions";
  const state = /^\/api\/comment-submissions\/([^/]+)\/acceptance$/.exec(pathname);
  const content = /^\/api\/comment-submissions\/([^/]+)\/items\/([^/]+)\/content$/.exec(pathname);
  const item = /^\/api\/comment-submissions\/([^/]+)\/items\/([^/]+)$/.exec(pathname);
  const action = /^\/api\/comment-submissions\/([^/]+)\/(finalize|cancel)$/.exec(pathname);
  const operation: Operation | null = collection && request.method === "POST" ? "create"
    : state && request.method === "GET" ? "state" : content && request.method === "PUT" ? "uploadItem"
    : item && request.method === "DELETE" ? "removeItem" : action && request.method === "POST" ? action[2] as "finalize" | "cancel" : null;
  if (!operation) throw new HTTPException(403, { message: "Original canonical Comment ingress is required." });
  function decode(value: string): string {
    let id: string;
    try { id = decodeURIComponent(value); } catch { throw new HTTPException(400, { message: "Invalid upload identifier" }); }
    if (!validSubmissionId(id)) throw new HTTPException(400, { message: "Invalid upload identifier" });
    return id;
  }
  const submissionId = collection ? undefined : decode((state ?? content ?? item ?? action)![1]!);
  const itemId = content || item ? decode((content ?? item)![2]!) : undefined;
  return { operation, submissionId, itemId };
}
/** Invoke the complete accepted-request algorithm only within its already
 * issued original Request execution. Used by the pending item DELETE branch;
 * it neither creates a second source lease nor exports its SQL/provider ports. */
export async function invokeLocalCommentAcceptanceRequest(execution: LocalUploadExecution,
  opening: LocalVolumeProfileOpening, request: Request, actor: string) {
  assertLocalUploadExecutionRequestOwner(execution, opening, request, actor);
  const { operation, submissionId, itemId } = captureCanonicalCommentOperation(request);
  async function bind(execution: LocalUploadExecution) {
    assertLocalUploadExecutionOwner(execution, opening);
    const defaults = await readSqlStorageRoleDefaults(execution.historyDatabase());
    if (!defaults || defaults.internal.policyRevision < 3) throw new CommentAcceptanceUnavailableError();
    const internal = captureLocalVolumeProfileAuthority(opening,
      { profileId: defaults.internal.storageProfileId, configurationRevision: 1 }, "write");
    const originals = captureLocalVolumeProfileAuthority(opening,
      { profileId: defaults.originals.storageProfileId, configurationRevision: 1 }, "write");
    const authorities = new Map<string, LocalVolumeProfileAuthority>([
      [internal.profile.profileId, internal], [originals.profile.profileId, originals],
    ]);
    const targets = Object.freeze({
      internal: { id: internal.profile.profileId, configurationRevision: 1 as const, namespaceIdentity: internal.profile.namespaceIdentity },
      originals: { id: originals.profile.profileId, configurationRevision: 1 as const, namespaceIdentity: originals.profile.namespaceIdentity },
    });
    const sourceStatements = new WeakMap<FileAuthoritySqlStatement, string>();
    const sourceBindings = new WeakMap<FileAuthoritySqlStatement, Parameters<FileAuthoritySqlStatement["bind"]>>();
    // Rebind only privately created exact original statements on the fresh
    // authority view. A compatible accepted destination remains immutable even
    // after defaults change; its actual Local physical owner is captured below.
    async function execute(items: readonly FileAuthoritySqlStatement[]) {
      assertLocalUploadExecutionOwner(execution, opening);
      const database = execution.database([...authorities.values()]);
      const guards = [...authorities.values()].map(authority => prepareLocalVolumeProfileAuthorityFence(authority, database));
      guards.push(prepareLocalVolumeRoleSelectionFence(database, defaults!.internal.policyRevision, targets));
      const selected = items.map(item => {
        const sql = sourceStatements.get(item), values = sourceBindings.get(item);
        if (sql === undefined || !values) throw new Error("Original canonical Comment SQL ownership is required");
        return database.prepare(sql).bind(...values);
      });
      return (await database.batch([...guards, ...selected])).slice(guards.length);
    }
    function fileStatement(sql: string, bindings: Parameters<FileAuthoritySqlStatement["bind"]> = []): FileAuthoritySqlStatement {
      const value: FileAuthoritySqlStatement = Object.freeze({
        bind(...values: Parameters<FileAuthoritySqlStatement["bind"]>) { return fileStatement(sql, values); },
        async first() { return (await execute([value]))[0]!.results[0] ?? null; },
        async all() { return (await execute([value]))[0]!; },
        async run() { return (await execute([value]))[0]!; },
      });
      sourceStatements.set(value, sql); sourceBindings.set(value, bindings); return value;
    }
    const file: FileAuthoritySqlDatabase = Object.freeze({
      prepare: fileStatement,
      primary() { assertLocalUploadExecutionOwner(execution, opening); return file; },
      batch: execute,
    });
    function row(value: FileAuthoritySqlRow) {
      const result = { ...value };
      for (const name of ["count", "position", "storage_profile_revision", "storage_policy_revision", "storage_role_policy_revision",
        "role_selection_revision", "expected_byte_size", "byte_size", "visible", "available"])
        if (result[name] !== undefined && result[name] !== null) result[name] = configurationSqlInteger(result[name], `Comment.${name}`);
      return result;
    }
    const statements = new WeakMap<Statement, FileAuthoritySqlStatement>();
    function wrap(statement: FileAuthoritySqlStatement): Statement {
      const value: Statement = Object.freeze({
        bind(...values: unknown[]) { return wrap(statement.bind(...values.map(configurationSqlCell))); },
        async first<Row>() { const selected = await statement.first(); return selected === null ? null : row(selected) as Row; },
        async all<Row>() { return { results: (await statement.all()).results.map(value => row(value) as Row) }; },
      });
      statements.set(value, statement); return value;
    }
    const database: CommentAcceptanceDatabase<Statement> = Object.freeze({
      prepare(sql: string) { return wrap(file.prepare(sql)); },
      primary() { file.primary(); return database; },
      async batch(items: Statement[]) {
        const results = await file.batch(items.map(item => {
          const value = statements.get(item);
          if (!value) throw new Error("Original canonical Comment statement ownership is required");
          return value;
        }));
        return results.map(result => ({ results: result.results.map(row) }));
      },
    });
    function sameDatabase(value: CommentAcceptanceDatabase<Statement>) {
      if (value !== database) throw new Error("Original canonical Comment database ownership is required");
      assertLocalUploadExecutionOwner(execution, opening); return file;
    }
    function purpose(value: FilePurpose) {
      if (!["embedded_content", "derived_preview", "research_source"].includes(value)) throw new CommentAcceptanceUnavailableError();
      return value === "research_source" ? targets.originals : targets.internal;
    }
    const bodyFailures: StorageProfileCleanupError[] = [];
    function retainBodyFailure(error: unknown): void {
      if (error instanceof StorageProfileCleanupError) bodyFailures.push(error);
    }
    const unavailable = (): never => { throw new CommentAcceptanceUnavailableError(); };
    async function captureAcceptedProfile(owner: AuthorityCandidateOwner) {
      if (operation !== "uploadItem" || owner.kind !== "comment_item" || owner.acceptanceId !== itemId || owner.actorEmail !== actor)
        throw new HTTPException(403, { message: "Original canonical Comment upload owner changed." });
      const accepted = await file.prepare(`SELECT i.storage_profile_id,i.storage_profile_revision FROM comment_item_acceptances i
        JOIN comment_submission_acceptances p ON p.submission_id=i.submission_id
        WHERE i.item_id=? AND i.submission_id=? AND i.actor_email=? AND p.actor_email=?
          AND i.execution_token=? AND p.operation_id=? AND i.status='pending' AND p.status='pending'`)
        .bind(itemId!, submissionId!, actor, actor, owner.executionToken!, owner.operationId).first();
      if (!accepted || typeof accepted.storage_profile_id !== "string"
        || configurationSqlInteger(accepted.storage_profile_revision, "Comment.acceptedProfileRevision", 1) !== 1)
        throw new CommentAcceptanceUnavailableError();
      if (!authorities.has(accepted.storage_profile_id)) authorities.set(accepted.storage_profile_id,
        captureLocalVolumeProfileAuthority(opening, { profileId: accepted.storage_profile_id, configurationRevision: 1 }, "write"));
    }
    const selected: CommentAcceptancePorts<Statement> = Object.freeze({
      database, nativeAssetAdapter: "local", objectName: safeAttachmentObjectName,
      managedObjectKey: unavailable, ensureR2Profile: unavailable, ensureManagedProfile: unavailable,
      assertR2Profile: unavailable, assertManagedProfile: unavailable, r2Reader: unavailable,
      managedStorage: unavailable, verifyLegacyBytes: unavailable, ingestR2: unavailable,
      isLegacyHashMismatch: () => false, isLegacyByteSizeMismatch: () => false,
      async authorityMode(value) {
        const current = await sameDatabase(value).prepare("SELECT mode FROM file_authority_control WHERE singleton=1").first();
        if (current?.mode !== "active") throw new CommentAcceptanceUnavailableError();
        return "active" as const;
      },
      acceptanceModeFence(value, mode) {
        if (mode !== "active") throw new CommentAcceptanceUnavailableError();
        return wrap(sameDatabase(value).prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active') THEN 1 ELSE json('Comment File authority mode changed') END"));
      },
      async selectRoles(value, purposes) {
        sameDatabase(value); purposes.forEach(purpose);
        return { selectionRevision: defaults!.internal.policyRevision, statements: [], profileFor: purpose };
      },
      verifyAcceptedFile(input) { purpose(input.purpose); return verifyOwnedAcceptedResultFile({ openRead: execution.openRead.bind(execution) }, input); },
      async boundedBody(value, maximum) {
        if (value !== request) throw new HTTPException(403, { message: "Original canonical Comment body changed." });
        try { return await (execution.readCommentAcceptanceBody ? execution.readCommentAcceptanceBody(maximum) : readOwnedCommentAcceptanceBody(request, maximum)); }
        catch (error) { retainBodyFailure(error); throw error; }
      },
      async verifyOriginalUploadBody(body, expected) {
        if (body !== request.body) throw new HTTPException(403, { message: "Original canonical Comment body changed." });
        let scope: ReturnType<typeof ownedCommentAcceptanceBody> | undefined, workError: unknown, failed = false;
        try { scope = ownedCommentAcceptanceBody(request); await verifyByteStream(scope.body, expected, nodeSha256, "source"); }
        catch (error) { failed = true; workError = error; retainBodyFailure(error); }
        if (scope) { try { await scope.dispose(workError); } catch (error) { retainBodyFailure(error); throw error; } }
        if (failed) throw workError;
      },
      async stageCandidate(value, owner) { sameDatabase(value); await captureAcceptedProfile(owner); return stageAuthorityCandidate(file, owner); },
      async writeCandidate(owner, candidate, input) {
        await captureAcceptedProfile(owner);
        let scope: ReturnType<typeof ownedCommentAcceptanceBody> | undefined;
        let workError: unknown, failed = false, answer: Awaited<ReturnType<typeof writeAuthorityCandidate>> | undefined;
        try {
          if (!(input.body instanceof ArrayBuffer) && input.body !== request.body)
            throw new HTTPException(403, { message: "Original canonical Comment body changed." });
          const body = input.body instanceof ArrayBuffer ? input.body : (scope = ownedCommentAcceptanceBody(request)).body;
          answer = await writeAuthorityCandidate({ database: file, openProfile(frozen, access, lifecycle) {
            return execution.openProfile(frozen, access, { ...lifecycle, async beforeRequest(operation) {
              if (lifecycle.beforeRequest && await lifecycle.beforeRequest(operation) !== true) return false;
              await file.batch([]); return true;
            } });
          } }, owner, candidate, { ...input, body });
        } catch (error) { failed = true; workError = error; retainBodyFailure(error); }
        if (scope) { try { await scope.dispose(workError); } catch (error) { retainBodyFailure(error); throw error; } }
        if (failed) throw workError;
        return { result: answer!.result, statements: answer!.statements.map(wrap) };
      },
      nativeAlias(value, input) { return wrap(prepareNativeAssetAliasInsert(sameDatabase(value), input)); },
    } satisfies CommentAcceptancePorts<Statement>);
    return { selected, bodyFailures, assertCurrent: () => execution.assertCommentRequestCurrent ? execution.assertCommentRequestCurrent() : file.batch([]) };
  }
  const bound = await bind(execution), input = { ports: bound.selected, request, actor, parameters: { submissionId, itemId } };
  let answer: Awaited<ReturnType<typeof acceptedComment>> | undefined, workError: unknown, failed = false;
  try {
    answer = await (operation === "create" ? createAcceptedComment : operation === "state" ? acceptedComment
      : operation === "uploadItem" ? uploadAcceptedCommentItem : operation === "finalize" ? finalizeAcceptedComment
        : operation === "cancel" ? cancelAcceptedComment : removeAcceptedCommentItem)(input);
  } catch (error) { failed = true; workError = error; }
  let currentError: unknown, currentFailed = false;
  try { await bound.assertCurrent(); } catch (error) { currentFailed = true; currentError = error; }
  // New V28 final admission may fail after original work. Preserve nested
  // typed cleanup causes directly for native/source quarantine; never conceal
  // them in an ordinary HTTP denial or discard a falsy original thrown value.
  const originalCleanupFailures: StorageProfileCleanupError[] = [];
  if (execution.assertCommentRequestCurrent) {
    const seen = new Set<unknown>();
    function retainOriginalCleanup(value: unknown): void {
      if (seen.has(value)) return; seen.add(value);
      if (value instanceof StorageProfileCleanupError) originalCleanupFailures.push(value);
      else if (value instanceof AggregateError) for (const original of value.errors) retainOriginalCleanup(original);
      if (value instanceof Error && value.cause !== undefined) retainOriginalCleanup(value.cause);
    }
    if (failed) retainOriginalCleanup(workError);
    if (currentFailed) retainOriginalCleanup(currentError);
  }
  if (bound.bodyFailures.length || originalCleanupFailures.length) {
    let retained!: Promise<void>;
    const failure = new StorageProfileCleanupError(new AggregateError([
      ...(failed ? [workError] : []), ...(currentFailed ? [currentError] : []),
    ], "Canonical Comment work and final current request admission"),
    new AggregateError([...bound.bodyFailures, ...originalCleanupFailures], "Original canonical Comment body/provider cleanup remains unresolved"), {
      owner: Object.freeze({ request, opening, execution, bodyFailures: bound.bodyFailures, originalCleanupFailures, workError, currentError }), dispose: () => retained,
    });
    retained = Promise.reject(failure); retained.then(() => undefined, () => undefined); throw failure;
  }
  if (failed && currentFailed && execution.assertCommentRequestCurrent) {
    const status = currentError instanceof HTTPException && currentError.status === 401 ? 401
      : currentError instanceof HTTPException && currentError.status === 403 ? 403 : 503;
    throw new HTTPException(status, { message: "Current canonical Comment request admission is required.",
      cause: new AggregateError([workError, currentError], "Original canonical Comment work and final admission failed") });
  }
  if (currentFailed) throw currentError;
  if (failed) throw workError;
  return answer!;

}
export function createLocalCommentAcceptanceExecution(options: {
  opening: LocalVolumeProfileOpening; authentication: object; request: Request;
  actor: string; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "actor,admission,authentication,opening,request")
    throw new Error("Canonical Comment request policy is unavailable");
  const { opening, request, actor } = options;
  if (!(request instanceof Request) || request.bodyUsed)
    throw new HTTPException(403, { message: "Original canonical Comment ingress is required." });
  const { operation } = captureCanonicalCommentOperation(request);
  const original = createLocalUploadExecution(options);
  function run(selectedOperation: Operation) {
    if (selectedOperation !== operation) throw new HTTPException(403, { message: "Original canonical Comment operation changed." });
    return original.run(execution => invokeLocalCommentAcceptanceRequest(execution, opening, request, actor));
  }
  return Object.freeze({ settled: original.settled, dispose: original.dispose.bind(original),
    create: () => run("create"), state: () => run("state"), uploadItem: () => run("uploadItem"),
    finalize: () => run("finalize"), cancel: () => run("cancel"), removeItem: () => run("removeItem"),
  });
}
