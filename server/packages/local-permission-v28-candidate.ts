import { HTTPException } from "hono/http-exception";
import type { FilePurpose } from "../../shared/contracts/files";
import { checkedResearchExportInput, checkedResearchExportPlanInput, checkedResearchImportInput,
  checkedResearchJobControl, checkedResearchUploadInput, type ResearchRoot } from "../../shared/contracts/research-package-api";
import { canonicalIdentityText } from "../../shared/contracts/request-subject";
import { stableJson } from "../../shared/domain/content-addressing";
import { prepareImportDomainPublication, type FrozenImportDomainPlan } from "../../worker/packages/import-domain";
import { PACKAGE_HTTP_ROUTES } from "../../worker/packages/routes-core";
import type { PackageAcceptance } from "../../worker/packages/jobs/sql-repository";
import type { PackageClaim, PackageJob } from "../../worker/packages/jobs/types";
import type { JobSqlDatabase, JobSqlStatement } from "../../worker/files/jobs/sql-repository";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { localJobPrincipalId, ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "../files/jobs/principal-authority";
import type { ReviewedInstallationAdmission } from "../migrations";
import { type SqliteBatchAdmissionCheck } from "../sqlite";
import { assertLocalVolumeProfileOpeningV28Binding } from "../storage/local-volume-profile-opening";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";

declare const brand: unique symbol;
export interface LocalPackagePermissionV28Candidate { readonly [brand]: true }
type Resource = Readonly<{ kind: "sample" | "project" | "template"; id: string }>;
type Purpose = Readonly<{ roots: readonly Resource[]; fresh: readonly Resource[]; jobId?: string }>;
type Session = Readonly<{ subject: LocalRequestSubject; principalId: string; actor: string; tokenHash: string; credentialRevision: bigint; createdAt: bigint }>;
type PermissionOwner = Readonly<{ kind: "package"; opening: LocalVolumeProfileOpeningV28Candidate; request: Request; actor: string;
  assertCurrent(): void; preflight(): readonly SqliteBatchAdmissionCheck[]; final(): readonly SqliteBatchAdmissionCheck[];
  business(file?: Readonly<{ fileId: string; purpose: FilePurpose }>): readonly SqliteBatchAdmissionCheck[];
  authorized(): boolean; selectJson(value: unknown): void; accept(value: PackageAcceptance, database: JobSqlDatabase): void }>;
const issued = new WeakMap<LocalPackagePermissionV28Candidate, PermissionOwner>(), consumed = new WeakSet<LocalPackagePermissionV28Candidate>();
const denied = () => new HTTPException(403, { message: "Current Group Package root permission is required." });
const unavailable = () => new HTTPException(503, { message: "Current V28 Package authority is unavailable." });
const EMPTY: Purpose = Object.freeze({ roots: Object.freeze([]), fresh: Object.freeze([]) });
const liveRoot = `(r.root_kind='sample' AND EXISTS(SELECT 1 FROM samples WHERE id=r.root_id AND deleted_at IS NULL))
  OR(r.root_kind='project' AND EXISTS(SELECT 1 FROM projects WHERE id=r.root_id AND deleted_at IS NULL))
  OR(r.root_kind='template' AND EXISTS(SELECT 1 FROM recipe_families WHERE id=r.root_id AND archived_at IS NULL))`;
// One fixed Group predicate, correlated to this genuine local identity. It is
// part of a raising original same-BEGIN admission, never a cached JS decision.
const groupSql = `EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')
 AND EXISTS(SELECT 1 FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
  WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'
   AND NOT EXISTS(SELECT 1 FROM json_each(?) selection WHERE NOT EXISTS(
    SELECT 1 FROM collaboration_resources r LEFT JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=m.member_id
    WHERE r.root_kind=json_extract(selection.value,'$.kind') AND r.root_id=json_extract(selection.value,'$.id') AND (${liveRoot})
      AND(r.visibility='workspace' OR(g.enabled=1 AND g.capability IN('read','operate','edit','manage')))))
   AND NOT EXISTS(SELECT 1 FROM json_each(?) selection WHERE
    CASE json_extract(selection.value,'$.kind') WHEN 'sample' THEN m.can_create_samples WHEN 'project' THEN m.can_create_projects WHEN 'template' THEN m.can_create_templates ELSE 0 END<>1
    OR EXISTS(SELECT 1 FROM collaboration_resources r WHERE r.root_kind=json_extract(selection.value,'$.kind') AND r.root_id=json_extract(selection.value,'$.id'))
    OR(json_extract(selection.value,'$.kind')='sample' AND EXISTS(SELECT 1 FROM samples WHERE id=json_extract(selection.value,'$.id')))
    OR(json_extract(selection.value,'$.kind')='project' AND EXISTS(SELECT 1 FROM projects WHERE id=json_extract(selection.value,'$.id')))
    OR(json_extract(selection.value,'$.kind')='template' AND EXISTS(SELECT 1 FROM recipe_families WHERE id=json_extract(selection.value,'$.id')))))`;
function resources(plan: FrozenImportDomainPlan): readonly Resource[] {
  if (plan.schema !== "research-domain-import/1" || !Array.isArray(plan.rows) || plan.rows.length > 1200 || !Array.isArray(plan.roots) || plan.roots.length > 20) throw denied();
  const found = new Map<string, Resource>();
  for (const row of plan.rows) {
    const kind = row.kind === "sample" ? "sample" : row.kind === "project" ? "project" : row.kind === "recipeFamily" ? "template" : null;
    if (kind === null) continue;
    const id = row.data.id;
    if (!canonicalIdentityText(id, 256) || row.id !== id || row.table !== (kind === "sample" ? "samples" : kind === "project" ? "projects" : "recipe_families")) throw denied();
    const key = kind + ":" + id; if (found.has(key)) throw denied(); found.set(key, Object.freeze({ kind, id }));
  }
  for (const root of plan.roots) if (!found.has(root.kind + ":" + root.id)) throw denied();
  const value = Object.freeze([...found.values()]);
  if (new TextEncoder().encode(stableJson(value)).byteLength > 96 * 1024) throw denied();
  return value;
}
function exportRoots(value: readonly ResearchRoot[]): readonly Resource[] {
  if (value.length < 1 || value.length > 20) throw denied();
  return Object.freeze(value.map(root => Object.freeze({ kind: root.kind, id: root.id })));
}
function purpose(job: PackageJob): Purpose {
  if (job.kind === "data_package" || job.kind === "report") return Object.freeze({ roots: exportRoots(checkedResearchExportInput(JSON.parse(job.input_json)).roots), fresh: EMPTY.fresh, jobId: job.id });
  if (job.kind !== "import") return Object.freeze({ ...EMPTY, jobId: job.id });
  if (!job.domain_plan_json) throw denied();
  const plan = JSON.parse(job.domain_plan_json) as FrozenImportDomainPlan, allocated = resources(plan);
  return job.state === "completed" ? Object.freeze({ roots: allocated, fresh: EMPTY.fresh, jobId: job.id })
    : Object.freeze({ roots: EMPTY.roots, fresh: allocated, jobId: job.id });
}
function groupValues(installationId: string, principalId: string, selected: Purpose) {
  return [`node-installation:${installationId}`, principalId, stableJson(selected.roots), stableJson(selected.fresh)];
}
export function ownedLocalPackagePermissionV28Candidate(token: LocalPackagePermissionV28Candidate,
  opening: LocalVolumeProfileOpeningV28Candidate, request: Request, actor: string): PermissionOwner {
  const owner = issued.get(token);
  if (!owner || owner.opening !== opening || owner.request !== request || owner.actor !== actor) throw denied();
  owner.assertCurrent(); return owner;
}
export function consumeLocalPackageExecutionPermissionV28Candidate(token: LocalPackagePermissionV28Candidate,
  opening: LocalVolumeProfileOpeningV28Candidate, request: Request, actor: string): PermissionOwner {
  const owner = ownedLocalPackagePermissionV28Candidate(token, opening, request, actor);
  if (consumed.has(token)) throw denied(); consumed.add(token); return owner;
}
/** Actual Request, local session and fixed Group-purpose issuer. No options
 * callback, supplied subject, administrator flag or SQL fragment can issue it. */
export function createLocalPackagePermissionV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,opening") throw unavailable();
  const { opening, authentication, admission } = options, physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  const { database, nativeDatabase, writerLease } = physical, auth = localAuthenticationIdentityAuthority(authentication);
  assertLocalVolumeProfileOpeningV28Binding(opening,database,nativeDatabase,writerLease,authentication);
  const identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  const installation = identity.installation, issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, writerLease, authentication, admission });
  if (physical.installationCheckpointId !== "portable-runtime/v28" || physical.installationId !== installation.installationId) throw unavailable();
  const pending = new Set<Promise<unknown>>(); let active = true, closing: Promise<void> | undefined;
  function track<T>(value: Promise<T>) { pending.add(value); void value.then(() => pending.delete(value), () => pending.delete(value)); return value; }
  function current() { if (!active || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied(); assertLocalVolumeProfileOpeningV28Binding(opening,database,nativeDatabase,writerLease,authentication); identity.assertCurrent(); }
  function capture(request: Request): Promise<LocalPackagePermissionV28Candidate> {
    current(); if (closing || !(request instanceof Request) || request.bodyUsed || request.body?.locked) throw denied();
    const url = new URL(request.url), method = request.method, originalUrl = request.url;
    if (!PACKAGE_HTTP_ROUTES.some(route => route.method === method && new RegExp(`^/api${route.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(url.pathname))) throw denied();
    const jobMatch = /^\/api\/packages\/jobs\/([^/]+)(?:\/(?:upload-intent|upload|preview|control|download))?$/.exec(url.pathname);
    const receiptMatch = /^\/api\/packages\/requests\/([^/]+)$/.exec(url.pathname);
    const decode = (id: string) => { let decoded: string; try { decoded = decodeURIComponent(id); } catch { throw denied(); } if (!canonicalIdentityText(decoded, 128) || /[/\\]/.test(decoded)) throw denied(); return decoded; };
    const jobId = jobMatch ? decode(jobMatch[1]) : undefined, requestId = receiptMatch ? decode(receiptMatch[1]) : undefined;
    return track(Promise.resolve().then(async () => {
      const subject = await issuer.issue(request), facts = issuer.read(request, subject);
      if (facts.provider !== "local" || facts.issuer !== `node-installation:${installation.installationId}`) throw denied();
      const actor = `local-account:${facts.subject}`, tokenHash = auth.captureSessionDigest(request);
      const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
      statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
      if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
      const session: Session = Object.freeze({ subject, principalId: facts.subject, actor, tokenHash, credentialRevision: row.credential_revision, createdAt: row.created_at });
      let selected: Purpose = EMPTY, input: unknown, inputSeen = false, inputRequestId: string | undefined;
      function assertCurrent() {
        current(); if (request.url !== originalUrl || request.method !== method) throw denied();
        const now = issuer.read(request, session.subject);
        if (now.provider !== "local" || now.issuer !== facts.issuer || now.subject !== session.principalId
          || auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
      }
      function selectedPurpose(): Purpose {
        let id = selected.jobId ?? jobId;
        // Receipt replay is selected by the actual checked POST body or original GET URL.
        // The unchanged router can return repository.request before accept runs.
        const receiptId = requestId ?? inputRequestId;
        if (!id && receiptId) { const receipt = nativeDatabase.prepare("SELECT job_id FROM research_package_requests WHERE actor=? AND request_id=?").get(actor, receiptId); if (receipt?.job_id) id = String(receipt.job_id); }
        if (id) {
          const actual = nativeDatabase.prepare("SELECT * FROM research_package_jobs WHERE id=? AND actor=?").get(id, actor);
          if (!actual) throw denied(); return purpose(actual as unknown as PackageJob);
        }
        return selected;
      }
      function check(file?: Readonly<{ fileId: string; purpose: FilePurpose }>): SqliteBatchAdmissionCheck {
        assertCurrent(); const scope = selectedPurpose();
        if (file && (method !== "GET" || !url.pathname.endsWith("/download") || !jobId || file.purpose !== "job_output")) throw denied();
        const fileSql = file ? ` AND EXISTS(SELECT 1 FROM research_package_files output JOIN research_package_jobs job ON job.id=output.job_id
          WHERE job.id=? AND job.actor=? AND job.kind IN('data_package','report') AND job.state='completed'
            AND output.entry_kind='artifact' AND output.result_file_id=? AND output.purpose='job_output' AND output.state='published')` : "";
        const statement = database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
          CROSS JOIN(WITH observed AS MATERIALIZED(SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
          WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
            AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
            AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
            AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+?
            AND ${groupSql}${fileSql} LIMIT 1`).bind(tokenHash,session.principalId,session.credentialRevision,session.createdAt,identity.policy.idleLifetimeMs,
              ...groupValues(installation.installationId,session.principalId,scope), ...(file ? [jobId!,actor,file.fileId] : []));
        return { statement, rejection: denied() };
      }
      const owner: PermissionOwner = Object.freeze({ kind: "package", opening, request, actor, assertCurrent,
        preflight: () => [check()], business: file => [check(file)], final: () => [check()],
        authorized() { try { check(); const scope = selectedPurpose(); return nativeDatabase.prepare(`SELECT 1 admitted FROM local_accounts a
          WHERE a.principal_id=? AND a.enabled=1 AND ${groupSql}`).get(session.principalId,...groupValues(installation.installationId,session.principalId,scope))?.admitted === 1; } catch { return false; } },
        selectJson(value: unknown) {
          assertCurrent(); if (inputSeen) throw denied(); inputSeen = true;
          if (url.pathname === "/api/packages/plans") { input = checkedResearchExportPlanInput(value); selected = Object.freeze({ roots: exportRoots((input as ReturnType<typeof checkedResearchExportPlanInput>).roots), fresh: EMPTY.fresh }); }
          else if (url.pathname === "/api/packages/jobs") { const checked = checkedResearchExportInput(value); input = checked; inputRequestId = checked.requestId; selected = Object.freeze({ roots: exportRoots(checked.roots), fresh: EMPTY.fresh }); }
          else if (url.pathname === "/api/packages/uploads") { const checked = checkedResearchUploadInput(value); input = checked; inputRequestId = checked.requestId; }
          else if (url.pathname === "/api/packages/imports") { const checked = checkedResearchImportInput(value); input = checked; inputRequestId = checked.requestId; }
          else if (url.pathname.endsWith("/control")) input = checkedResearchJobControl(value);
          else throw denied();
        },
        accept(value: PackageAcceptance, port: JobSqlDatabase) {
          assertCurrent(); if (!inputSeen || value.actor !== actor || stableJson(value.input) !== stableJson(input)) throw denied();
          if (value.kind === "import") {
            if (url.pathname !== "/api/packages/imports" || !value.domainPlan) throw denied();
            const existing = nativeDatabase.prepare("SELECT * FROM research_package_jobs WHERE kind='import' AND actor=? AND package_digest=? AND copy_identity=?").get(actor,value.digest ?? null,value.copyIdentity ?? null);
            if (existing) selected = Object.freeze({ ...EMPTY, jobId: String(existing.id) });
            else { const plan = value.domainPlan as FrozenImportDomainPlan; prepareImportDomainPublication(port,plan); selected = Object.freeze({ roots: EMPTY.roots, fresh: resources(plan) }); }
          } else if (value.kind === "upload") { if (url.pathname !== "/api/packages/uploads") throw denied(); }
          else if (url.pathname !== "/api/packages/jobs") throw denied();
        },
      });
      if (!owner.authorized()) throw denied();
      const token = Object.freeze({}) as LocalPackagePermissionV28Candidate; issued.set(token, owner); return token;
    }));
  }
  return Object.freeze({ capture,
    close() { if (closing) return closing; closing = Promise.resolve().then(async () => { await Promise.allSettled([...pending]); active = false; }); void closing.catch(() => undefined); return closing; },
  });
}
/** Scheduled purpose comes only from the genuine privately registered V28
 * principal/opening/installed identity and immutable accepted job. */
export function createNodePackagePurposeV28Candidate(options: {
  authority: InstalledJobPrincipalAuthority; opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,authority,opening") throw unavailable();
  const { authority, opening, authentication, admission } = options, owner = ownedJobPrincipalAuthority(authority), physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  assertLocalVolumeProfileOpeningV28Binding(opening,owner.database,owner.nativeDatabase,physical.writerLease,authentication);
  const auth = localAuthenticationIdentityAuthority(authentication), identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity,owner.database,owner.nativeDatabase,admission);
  if (owner.database !== physical.database || owner.nativeDatabase !== physical.nativeDatabase || physical.installationCheckpointId !== "portable-runtime/v28"
    || identity.installation.installationId !== physical.installationId) throw unavailable();
  function current() { owner.assertCurrent(); assertLocalVolumeProfileOpeningV28Binding(opening,owner.database,owner.nativeDatabase,physical.writerLease,authentication); identity.assertCurrent(); if (localAuthenticationIdentityAuthority(authentication) !== auth) throw unavailable(); }
  function selection(actor: string, id?: string) {
    current(); const principalId = localJobPrincipalId(actor); if (!principalId) throw denied();
    const actual = id === undefined ? undefined : owner.nativeDatabase.prepare("SELECT * FROM research_package_jobs WHERE id=? AND actor=?").get(id,actor);
    if (id !== undefined && !actual) throw denied();
    return { principalId, purpose: actual ? purpose(actual as unknown as PackageJob) : EMPTY };
  }
  function check(actor: string, id?: string): SqliteBatchAdmissionCheck {
    const selected = selection(actor,id);
    return { statement: owner.database.prepare(`SELECT 1 admitted FROM local_accounts a WHERE a.principal_id=? AND a.enabled=1 AND ${groupSql}`)
      .bind(selected.principalId,...groupValues(identity.installation.installationId,selected.principalId,selected.purpose)), rejection: denied() };
  }
  return Object.freeze({ current,
    checks: (actor: string, id?: string) => [check(actor,id)],
    actorAllowed(actor: string, id?: string) { try { const selected = selection(actor,id); return owner.nativeDatabase.prepare(`SELECT 1 admitted FROM local_accounts a WHERE a.principal_id=? AND a.enabled=1 AND ${groupSql}`)
      .get(selected.principalId,...groupValues(identity.installation.installationId,selected.principalId,selected.purpose))?.admitted === 1; } catch { return false; } },
    publication(claim: PackageClaim, database: JobSqlDatabase, original: readonly JobSqlStatement[]) {
      current(); if (claim.kind !== "import" || !claim.domain_plan_json) throw denied();
      const actual = owner.nativeDatabase.prepare("SELECT * FROM research_package_jobs WHERE id=? AND actor=?").get(claim.id,claim.actor);
      if (!actual || actual.kind !== "import" || actual.state !== "running" || actual.owner_token !== claim.owner_token
        || actual.generation !== claim.generation || actual.runtime_incarnation !== claim.runtime_incarnation
        || actual.lease_expires_at !== claim.lease_expires_at || actual.domain_plan_json !== claim.domain_plan_json) throw denied();
      const plan = JSON.parse(claim.domain_plan_json) as FrozenImportDomainPlan, fresh = resources(plan), json = stableJson(fresh), principalId = localJobPrincipalId(claim.actor);
      if (!principalId || original.length !== plan.publicationStatements || original.length > 112) throw denied();
      return [...original,
        database.prepare(`INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision)
          SELECT json_extract(value,'$.kind'),json_extract(value,'$.id'),'restricted',1 FROM json_each(?)`).bind(json),
        database.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
          SELECT json_extract(selection.value,'$.kind'),json_extract(selection.value,'$.id'),m.member_id,'manage',1,1
          FROM json_each(?) selection JOIN collaboration_identities i ON i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1
          JOIN collaboration_members m ON m.member_id=i.member_id AND m.state='active'`).bind(json,`node-installation:${identity.installation.installationId}`,principalId),
        database.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) selection WHERE NOT EXISTS(
          SELECT 1 FROM collaboration_resources r JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
          JOIN collaboration_identities i ON i.member_id=g.member_id AND i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1
          JOIN collaboration_members m ON m.member_id=i.member_id AND m.state='active'
          WHERE r.root_kind=json_extract(selection.value,'$.kind') AND r.root_id=json_extract(selection.value,'$.id')
            AND r.visibility='restricted' AND g.enabled=1 AND g.capability='manage')) THEN 1 ELSE json('Original imported Group roots did not publish') END`)
          .bind(json,`node-installation:${identity.installation.installationId}`,principalId),
      ];
    },
  });
}
