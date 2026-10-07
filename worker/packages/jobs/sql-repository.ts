import { stableJson } from "../../../shared/domain/content-addressing";
import type { JobSqlDatabase, JobSqlStatement } from "../../files/jobs/sql-repository";
import type { PackageClaim, PackageFile, PackageAttempt, PackageJob, PackageKind, PackageRecord,
  PackageRepository, PackageStatus, PackageTargets } from "./types";

const execution = `EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg
 ON fg.singleton=g.singleton AND fg.enabled=1 JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
 WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=research_package_jobs.runtime_incarnation)`;
const owned = `id=? AND owner_token=? AND generation=? AND runtime_incarnation=? AND state='running'
 AND julianday(lease_expires_at)>julianday('now') AND ${execution}`;
const claimValues = (c: PackageClaim) => [c.id,c.owner_token,c.generation,c.runtime_incarnation];
export interface PackageAcceptance {
  id: string; requestId: string; actor: string; kind: PackageKind; input: unknown; packageId: string;
  sourceInstallationId: string; targets: PackageTargets; sourceUploadJobId?: string; digest?: string;
  copyIdentity?: string; domainPlan?: unknown; files?: readonly PackageFileInput[];
  statements?: (db: JobSqlDatabase, jobId: string, acceptedAt: string) => readonly JobSqlStatement[];
}
export interface PackageFileInput {
  packageFileId: string; purpose: PackageFile["purpose"]; byteSize: number; sha256: string;
  path: string; mediaType: string; entryKind: "payload" | "artifact"; entry?: unknown;
  fileId: string; assetId?: string; reuse?: { fileId: string; locationId: string; assetId: string };
  originalName?:string|null;aliasCreatedAt?:string;
}
export class SqlPackageRepository implements PackageRepository {
  constructor(public readonly database: JobSqlDatabase, private readonly clock = () => new Date(),
    private readonly randomId = () => crypto.randomUUID()) {}
  private now() { return this.clock().toISOString(); }
  guard(db: JobSqlDatabase, claim: PackageClaim) {
    return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM research_package_jobs WHERE ${owned})
      THEN 1 ELSE json('Package lease is unavailable') END`).bind(...claimValues(claim));
  }
  async request(requestId: string, actor: string, input?: unknown) {
    const receipt = await this.database.primary().prepare(`SELECT input_json,job_id,reused FROM research_package_requests WHERE actor=? AND request_id=?`)
      .bind(actor,requestId).first<{ input_json: string; job_id: string; reused: number }>();
    if (!receipt) return null;
    if (input !== undefined && receipt.input_json !== stableJson(input)) throw new Error("Package request differs from its accepted input");
    const job = await this.status(receipt.job_id,actor);
    if (!job) throw new Error("Package request is unavailable");
    return { requestId,job,reused: receipt.reused === 1 };
  }
  fileStatement(db: JobSqlDatabase, jobId: string, targets: PackageTargets, input: PackageFileInput) {
    const t = targets[input.purpose], reuse = input.reuse, at = this.now();
    if (!t || (input.entryKind === "artifact" && (input.packageFileId !== "@archive" || input.purpose !== "job_output"))) throw new Error("Invalid frozen package target");
    return db.prepare(`INSERT INTO research_package_files(job_id,logical_file_id,entry_kind,purpose,byte_size,sha256,archive_path,media_type,
      hold_operation_id,target_profile_id,target_profile_revision,target_namespace,target_policy_revision,candidate_file_id,candidate_asset_id,
      archive_entry_json,reuse_file_id,reuse_location_id,reuse_asset_id,state,result_file_id,result_location_id,updated_at,alias_original_name,alias_created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(jobId,input.packageFileId,input.entryKind,input.purpose,input.byteSize,input.sha256,input.path,input.mediaType,
        this.randomId(),t.profileId,t.configurationRevision,t.namespaceIdentity,t.policyRevision,reuse?.fileId ?? input.fileId,
        reuse?.assetId ?? input.assetId ?? null,input.entry === undefined ? null : stableJson(input.entry),
        reuse?.fileId ?? null,reuse?.locationId ?? null,reuse?.assetId ?? null,reuse ? "verified" : "pending",
        reuse?.fileId ?? null,reuse?.locationId ?? null,at,input.originalName??null,input.aliasCreatedAt??null);
  }
  async accept(input: PackageAcceptance, authorize: () => boolean) {
    if (!authorize()) throw new Error("Package actor is unavailable");
    const prior = await this.request(input.requestId,input.actor,input.input); if (prior) return prior;
    const db = this.database.primary(), at = this.now();
    // Normal repeated import aliases one durable copy. Another copy has its own
    // explicit identity; no title/hash lookup ever merges research entities.
    const existing = input.kind === "import" ? await db.prepare(`SELECT id FROM research_package_jobs
      WHERE kind='import' AND actor=? AND package_digest=? AND destination_scope='system' AND copy_identity=?`)
      .bind(input.actor,input.digest,input.copyIdentity).first<{ id: string }>() : null;
    if (existing) {
      const original = await this.job(existing.id);
      if (original?.actor !== input.actor) throw new Error("This package already has an import in the destination scope");
      try { await db.prepare(`INSERT INTO research_package_requests(actor,request_id,input_json,job_id,accepted_at,reused)
        VALUES(?,?,?,?,?,1)`).bind(input.actor,input.requestId,stableJson(input.input),existing.id,at).run(); } catch { /* Fresh receipt settles an uncertain acknowledgement. */ }
      return (await this.request(input.requestId,input.actor,input.input))!;
    }
    const phase = input.kind === "upload" ? "write" : input.kind === "import" ? "copy" : "snapshot";
    const statements: JobSqlStatement[] = [db.prepare(`INSERT INTO research_package_jobs(id,request_id,actor,kind,input_json,package_id,
      source_installation_id,source_upload_job_id,package_digest,copy_identity,accepted_at,target_policy_json,domain_plan_json,state,phase,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.id,input.requestId,input.actor,input.kind,stableJson(input.input),input.packageId,
        input.sourceInstallationId,input.sourceUploadJobId ?? null,input.digest ?? null,input.copyIdentity ?? null,at,
        stableJson(input.targets),input.domainPlan === undefined ? null : stableJson(input.domainPlan),
        input.kind === "upload" ? "awaiting_upload" : "queued",phase,at),
      db.prepare(`INSERT INTO research_package_requests(actor,request_id,input_json,job_id,accepted_at,reused) VALUES(?,?,?,?,?,0)`)
        .bind(input.actor,input.requestId,stableJson(input.input),input.id,at),
      ...input.statements?.(db,input.id,at) ?? [],
      ...(input.files ?? []).map(file => this.fileStatement(db,input.id,input.targets,file)),
    ];
    if (input.sourceUploadJobId) statements.push(db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
      SELECT ?,f.result_location_id,'accepted_operation',?,'Accepted package copy source archive',? FROM research_package_files f
      JOIN research_package_jobs j ON j.id=f.job_id WHERE f.job_id=? AND f.entry_kind='artifact' AND f.state='published' AND j.state='preview'
      AND j.actor=? AND(j.expires_at IS NULL OR julianday(j.expires_at)>julianday('now'))
      AND EXISTS(SELECT 1 FROM file_holds h WHERE h.file_id=f.result_file_id AND h.operation_id='fp4-output:'||j.id AND h.released_at IS NULL)`).bind(this.randomId(),`fp4-source:${input.id}`,at,input.sourceUploadJobId,input.actor),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_location_holds WHERE operation_id=? AND released_at IS NULL)
      THEN 1 ELSE json('Validated package source changed') END`).bind(`fp4-source:${input.id}`));
    if(input.sourceUploadJobId)statements.push(db.prepare(`INSERT INTO research_package_records(job_id,record_kind,source_id,record_json,ordinal)
      SELECT ?,r.record_kind,r.source_id,r.record_json,r.ordinal FROM research_package_records r
      JOIN research_package_jobs source ON source.id=r.job_id WHERE source.id=? AND source.actor=? AND source.state='preview'
      AND json_extract(source.frozen_archive_json,'$.sha256')=?`).bind(input.id,input.sourceUploadJobId,input.actor,input.digest),
      db.prepare(`SELECT CASE WHEN(SELECT count(*) FROM research_package_records WHERE job_id=?)=(SELECT count(*) FROM research_package_records WHERE job_id=?)
        THEN 1 ELSE json('Package copied provenance changed') END`).bind(input.id,input.sourceUploadJobId));
    for (const file of input.files ?? []) if (file.reuse) statements.push(db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
      VALUES(?,?,'accepted_operation',?,'Accepted package canonical reuse',?)`).bind(this.randomId(),file.reuse.locationId,`fp4-reuse:${input.id}:${file.packageFileId}`,at));
    statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard g
      ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active') THEN 1 ELSE json('Package authority is unavailable') END`));
    if (!authorize()) throw new Error("Package actor is unavailable");
    try { await db.batch(statements); } catch { /* Never perform provider I/O before exact primary receipt reconciliation. */ }
    const committed = await this.request(input.requestId,input.actor,input.input);
    if (!committed) throw new Error("Package acceptance did not commit");
    return committed;
  }
  async job(id: string) { return this.database.primary().prepare("SELECT * FROM research_package_jobs WHERE id=?").bind(id).first<PackageJob>(); }
  async files(id: string) { return (await this.database.primary().prepare("SELECT * FROM research_package_files WHERE job_id=? ORDER BY entry_kind,archive_path")
    .bind(id).all<PackageFile>()).results; }
  async records(id: string) { return (await this.database.primary().prepare("SELECT record_kind,source_id,record_json,ordinal FROM research_package_records WHERE job_id=? ORDER BY ordinal,record_kind,source_id")
    .bind(id).all<PackageRecord>()).results; }
  async status(id: string, actor: string): Promise<PackageStatus | null> {
    const job = await this.job(id); if (!job || job.actor !== actor) return null;
    const files = (await this.files(id)).filter(file => file.entry_kind !== "artifact"), artifact = (await this.files(id)).find(file => file.entry_kind === "artifact");
    return { id,requestId:job.request_id,kind:job.kind,state:job.state,phase:job.phase,acceptedAt:job.accepted_at,updatedAt:job.updated_at,
      reason:job.reason,packageId:job.package_id,filesTotal:files.length,filesVerified:files.filter(file => ["verified","published"].includes(file.state)).length,
      bytesTotal:files.reduce((sum,file) => sum+file.byte_size,0),result:job.result_json ? JSON.parse(job.result_json) : null,
      downloadUrl:artifact?.state === "published" && job.kind !== "upload" && job.state === "completed" ? `/api/packages/jobs/${id}/download` : null,
      expiresAt:job.expires_at };
  }
  async list(actor: string) {
    const rows = await this.database.primary().prepare("SELECT id FROM research_package_jobs WHERE actor=? ORDER BY accepted_at DESC,id DESC LIMIT 100").bind(actor).all<{ id: string }>();
    return Promise.all(rows.results.map(async row => (await this.status(row.id,actor))!));
  }
  async claim(incarnation: string, owner: string, authorize: (actor: string) => boolean): Promise<PackageClaim | null> {
    const rows = await this.database.primary().prepare(`SELECT id,actor FROM research_package_jobs WHERE state='queued'
      OR(state='running' AND julianday(lease_expires_at)<=julianday('now')) ORDER BY updated_at,id LIMIT 10`).all<{ id: string; actor: string }>();
    for (const row of rows.results) {
      if (!authorize(row.actor)) { await this.database.primary().prepare("UPDATE research_package_jobs SET state='paused',reason='actor_revoked',generation=generation+1,updated_at=? WHERE id=? AND state IN('queued','running')")
        .bind(this.now(),row.id).run(); continue; }
      const claim = await this.claimOne(row.id,row.actor,incarnation,owner,false); if (claim) return claim;
    }
    return null;
  }
  async claimOne(id: string, actor: string, incarnation: string, owner: string, upload: boolean): Promise<PackageClaim | null> {
    const db = this.database.primary(), at = this.now(), lease = new Date(this.clock().getTime()+15*60_000).toISOString();
    try { await db.prepare(`UPDATE research_package_jobs SET state='running',owner_token=?,generation=generation+1,runtime_incarnation=?,
      lease_expires_at=?,actor_checked_at=?,updated_at=?,reason=NULL WHERE id=? AND actor=? AND
      (state='queued' OR(state='running' AND julianday(lease_expires_at)<=julianday('now')) ${upload ? "OR state='awaiting_upload'" : ""})
      AND EXISTS(SELECT 1 FROM file_job_runtime_guard g JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton AND fg.enabled=1
      JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active' WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?)`)
      .bind(owner,incarnation,lease,at,at,id,actor,incarnation).run(); } catch { /* Primary ownership read arbitrates lost ACK. */ }
    const claimed=await db.primary().prepare(`SELECT * FROM research_package_jobs WHERE id=? AND owner_token=? AND runtime_incarnation=? AND state='running' AND ${execution}`)
      .bind(id,owner,incarnation).first<PackageClaim>();
    if(claimed&&claimed.kind!=="import")await db.prepare(`INSERT INTO system_research_package_cleanup_grants(job_id,runtime_incarnation,requested_at,actor,mode)
      VALUES(?,?,?,?,'expiry') ON CONFLICT(job_id) DO NOTHING`).bind(id,incarnation,at,actor).run();
    return claimed;
  }
  async owns(claim: PackageClaim) { return Boolean(await this.database.primary().prepare(`SELECT 1 FROM research_package_jobs WHERE ${owned}`).bind(...claimValues(claim)).first()); }
  async attempt(file: PackageFile) { return this.database.primary().prepare(`SELECT * FROM research_package_attempts WHERE job_id=? AND logical_file_id=? ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1`)
    .bind(file.job_id,file.logical_file_id).first<PackageAttempt>(); }
  async stage(claim: PackageClaim, file: PackageFile) {
    const db = this.database.primary(), at = this.now(), id = this.randomId(), location = this.randomId();
    const key = `research-packages/${claim.id}/${id}`;
    try { await db.batch([this.guard(db,claim),
      db.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
        SELECT ?,?,'system',?,?,'unresolved',? WHERE NOT EXISTS(SELECT 1 FROM files WHERE id=?)`)
        .bind(file.candidate_file_id,file.purpose,file.byte_size,file.sha256,at,file.candidate_file_id),
      ...(file.entry_kind === "artifact" ? [db.prepare(`INSERT INTO file_holds(id,file_id,hold_kind,operation_id,reason,acquired_at)
        SELECT ?,?,'accepted_operation',?,'Retained package archive',? WHERE NOT EXISTS(SELECT 1 FROM file_holds WHERE file_id=? AND operation_id=?)`)
        .bind(this.randomId(),file.candidate_file_id,`fp4-output:${claim.id}`,at,file.candidate_file_id,`fp4-output:${claim.id}`)] : []),
      db.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,?,?,'unresolved',?)")
        .bind(location,file.candidate_file_id,file.target_profile_id,key,at),
      db.prepare(`INSERT INTO research_package_attempts(id,job_id,logical_file_id,file_id,location_id,object_key,owner_token,generation,runtime_incarnation,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'staged',?,?)`).bind(id,claim.id,file.logical_file_id,file.candidate_file_id,location,key,claim.owner_token,claim.generation,claim.runtime_incarnation,at,at),
      db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at) VALUES(?,?,'accepted_operation',?,'Package candidate write',?)`)
        .bind(this.randomId(),location,id,at),
      db.prepare("UPDATE research_package_files SET state='copying',updated_at=?,reason=NULL WHERE job_id=? AND logical_file_id=? AND state IN('pending','failed','copying')")
        .bind(at,claim.id,file.logical_file_id),
    ]); } catch { /* Fresh registered attempt is the only authority to send bytes. */ }
    const attempt = await db.primary().prepare(`SELECT * FROM research_package_attempts WHERE id=? AND job_id=? AND logical_file_id=?
      AND file_id=? AND location_id=? AND object_key=? AND owner_token=? AND generation=? AND runtime_incarnation=?`)
      .bind(id,claim.id,file.logical_file_id,file.candidate_file_id,location,key,claim.owner_token,claim.generation,claim.runtime_incarnation).first<PackageAttempt>();
    if (!attempt || attempt.id !== id || !await this.owns(claim)) throw new Error("Package candidate registration did not commit");
    return attempt;
  }
  async startWrite(claim: PackageClaim, attempt: PackageAttempt) {
    const db = this.database.primary(), at = this.now();
    try { await db.batch([this.guard(db,claim),db.prepare(`UPDATE research_package_attempts SET state='write_started',write_started_at=?,updated_at=?
      WHERE id=? AND state='staged' AND owner_token=? AND generation=? AND runtime_incarnation=?`)
      .bind(at,at,attempt.id,attempt.owner_token,attempt.generation,attempt.runtime_incarnation)]); } catch { /* Exact start receipt settles ACK loss. */ }
    const row = await db.primary().prepare("SELECT state,write_started_at FROM research_package_attempts WHERE id=?").bind(attempt.id).first<{ state:string;write_started_at:string }>();
    if (row?.state !== "write_started" || row.write_started_at !== at || !await this.owns(claim)) throw new Error("Package write admission did not commit");
    attempt.state="write_started";
  }
  async settled(attempt: PackageAttempt) {
    const at=this.now(); await this.database.primary().prepare(`UPDATE research_package_attempts SET io_settled_at=COALESCE(io_settled_at,?),updated_at=?
      WHERE id=? AND owner_token=? AND generation=? AND runtime_incarnation=? AND state IN('write_started','unknown','verified')`)
      .bind(at,at,attempt.id,attempt.owner_token,attempt.generation,attempt.runtime_incarnation).run(); attempt.io_settled_at ??= at;
  }
  async verify(claim: PackageClaim, file: PackageFile, attempt: PackageAttempt) {
    const db=this.database.primary(),at=this.now();
    try { await db.batch([this.guard(db,claim),db.prepare("UPDATE research_package_jobs SET actor_checked_at=? WHERE id=?").bind(at,claim.id),
      db.prepare(`UPDATE research_package_attempts SET state='verified',verified_byte_size=?,verified_sha256=?,verified_at=?,verified_owner_token=?,
        verified_generation=?,verified_runtime_incarnation=?,updated_at=? WHERE id=? AND io_settled_at IS NOT NULL AND state IN('write_started','unknown','verified')`)
        .bind(file.byte_size,file.sha256,at,claim.owner_token,claim.generation,claim.runtime_incarnation,at,attempt.id),
      db.prepare(`UPDATE research_package_files SET state='verified',result_file_id=?,result_location_id=?,updated_at=? WHERE job_id=? AND logical_file_id=?`)
        .bind(attempt.file_id,attempt.location_id,at,claim.id,file.logical_file_id),
      db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM research_package_live_verified_attempts WHERE id=?) THEN 1 ELSE json('Package verification lost ownership') END").bind(attempt.id),
    ]); } catch { /* Read exact evidence rather than assuming batch failure meant rollback. */ }
    if (!await db.primary().prepare("SELECT 1 FROM research_package_live_verified_attempts WHERE id=?").bind(attempt.id).first()) throw new Error("Package verification did not commit");
    attempt.state="verified";
  }
  async checkpoint(claim: PackageClaim, phase: string, values: { archive?:unknown;result?:unknown }={}) {
    const db=this.database.primary(),at=this.now();
    await db.batch([this.guard(db,claim),db.prepare(`UPDATE research_package_jobs SET phase=?,state=?,owner_token=NULL,lease_expires_at=NULL,
      updated_at=?,frozen_archive_json=COALESCE(frozen_archive_json,?),result_json=COALESCE(result_json,?) WHERE id=?`)
      .bind(phase,phase==="preview" ? "preview" : "queued",at,values.archive===undefined ? null : stableJson(values.archive),values.result===undefined ? null : stableJson(values.result),claim.id)]);
  }
  async addOutput(claim:PackageClaim, expectation:{byteSize:number;sha256:string}) {
    const db=this.database.primary(),targets=JSON.parse(claim.target_policy_json) as PackageTargets;
    const row=await db.prepare("SELECT 1 FROM research_package_files WHERE job_id=? AND entry_kind='artifact'").bind(claim.id).first();
    if(row) return;
    await db.batch([this.guard(db,claim),this.fileStatement(db,claim.id,targets,{packageFileId:"@archive",entryKind:"artifact",
      purpose:"job_output",byteSize:expectation.byteSize,sha256:expectation.sha256,path:"archive.zip",mediaType:"application/zip",fileId:this.randomId()})]);
  }
  async publishFile(claim:PackageClaim,file:PackageFile,attempt:PackageAttempt) {
    const db=this.database.primary(),at=this.now();
    try {await db.batch([this.guard(db,claim),db.prepare("UPDATE research_package_jobs SET actor_checked_at=? WHERE id=?").bind(at,claim.id),
      db.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
        SELECT location_id,file_id,target_profile_id,object_key,verified_byte_size,verified_sha256,'full_read_sha256',id,verified_at,?
        FROM research_package_live_verified_attempts a WHERE id=? AND NOT EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=a.location_id)`).bind(at,attempt.id),
      db.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
        SELECT file_id,purpose,'system',verified_byte_size,verified_sha256,location_id,'ready',? FROM research_package_live_verified_attempts a
        WHERE id=? AND NOT EXISTS(SELECT 1 FROM file_publications p WHERE p.file_id=a.file_id)`).bind(at,attempt.id),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_location_publications WHERE location_id=? AND verification_operation_id=? AND file_id=?)
        THEN 1 ELSE json('Package per-File publication lost ownership') END`).bind(attempt.location_id,attempt.id,file.candidate_file_id),
      db.prepare("UPDATE research_package_attempts SET state='published',updated_at=? WHERE id=? AND state='verified'").bind(at,attempt.id),
    ]);} catch {/* Exact immutable location proof settles ACK loss without resending bytes. */}
    if(!await db.primary().prepare("SELECT 1 FROM file_location_publications WHERE location_id=? AND verification_operation_id=?").bind(attempt.location_id,attempt.id).first()) throw new Error("Package per-File publication did not commit");
  }
  async pause(claim: PackageClaim, reason: string, attempt?:PackageAttempt|null) {
    if (!await this.owns(claim)) return; const db=this.database.primary(),at=this.now(),stmts=[this.guard(db,claim)];
    if(attempt) stmts.push(db.prepare(`UPDATE research_package_attempts SET state=CASE WHEN state IN('write_started','unknown') AND io_settled_at IS NULL THEN 'unknown'
      WHEN state='verified' THEN 'verified' ELSE 'failed' END,reason=?,updated_at=? WHERE id=? AND state<>'published'`).bind(reason,at,attempt.id));
    stmts.push(db.prepare("UPDATE research_package_jobs SET state='paused',reason=?,updated_at=?,owner_token=NULL,lease_expires_at=NULL WHERE id=?").bind(reason,at,claim.id));
    await db.batch(stmts);
  }
  async publish(claim: PackageClaim, domainStatements: readonly JobSqlStatement[]=[], result: unknown={roots:[],reused:false}) {
    const db=this.database.primary(),at=this.now(),expires=new Date(this.clock().getTime()+7*86400_000).toISOString();
    const statements=[this.guard(db,claim),db.prepare("UPDATE research_package_jobs SET actor_checked_at=? WHERE id=?").bind(at,claim.id),
      db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM research_package_files WHERE job_id=? AND entry_kind<>'source' AND state NOT IN('verified','published'))
        THEN 1 ELSE json('Package Files are incomplete') END`).bind(claim.id),
      db.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM research_package_files f WHERE f.job_id=? AND f.reuse_file_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM file_usable_publications p JOIN file_location_publications l ON l.location_id=p.active_location_id
        WHERE p.file_id=f.reuse_file_id AND p.purpose=f.purpose AND p.access_scope='system' AND p.verified_sha256=f.sha256 AND p.verified_byte_size=f.byte_size
        AND l.storage_profile_id=f.target_profile_id)) THEN 1 ELSE json('Package canonical reuse changed') END`).bind(claim.id),
      db.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
        SELECT location_id,file_id,target_profile_id,object_key,verified_byte_size,verified_sha256,'full_read_sha256',id,verified_at,?
        FROM research_package_live_verified_attempts a WHERE job_id=? AND NOT EXISTS(SELECT 1 FROM file_location_publications p WHERE p.location_id=a.location_id)`).bind(at,claim.id),
      db.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
        SELECT file_id,purpose,'system',verified_byte_size,verified_sha256,location_id,'ready',? FROM research_package_live_verified_attempts a
        WHERE job_id=? AND NOT EXISTS(SELECT 1 FROM file_publications p WHERE p.file_id=a.file_id)`).bind(at,claim.id),
      db.prepare(`INSERT INTO assets(id,import_id,r2_key,file_id,storage_profile_id,storage_profile_revision,object_key,original_name,mime_type,byte_size,status,sha256,actor_email,created_at)
        SELECT f.candidate_asset_id,NULL,NULL,f.result_file_id,f.target_profile_id,f.target_profile_revision,l.object_key,CASE WHEN f.alias_created_at IS NOT NULL THEN f.alias_original_name ELSE f.archive_path END,
          CASE WHEN f.alias_created_at IS NOT NULL THEN(SELECT json_extract(alias.value,'$.mimeType') FROM json_each(j.domain_plan_json,'$.files') alias
            WHERE json_extract(alias.value,'$.packageFileId')=f.logical_file_id) ELSE f.media_type END,f.byte_size,'ready',f.sha256,?,COALESCE(f.alias_created_at,?)
        FROM research_package_files f JOIN file_location_publications l ON l.location_id=f.result_location_id
        JOIN research_package_jobs j ON j.id=f.job_id WHERE f.job_id=? AND f.entry_kind='payload' AND f.reuse_file_id IS NULL AND f.candidate_asset_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=f.candidate_asset_id)`).bind(claim.actor,at,claim.id),
      ...domainStatements,
      db.prepare(`UPDATE research_package_attempts SET state='published',updated_at=? WHERE job_id=? AND state='verified' AND EXISTS(
        SELECT 1 FROM file_location_publications l JOIN research_package_files f ON f.job_id=research_package_attempts.job_id
        AND f.logical_file_id=research_package_attempts.logical_file_id WHERE l.location_id=research_package_attempts.location_id
        AND l.verification_operation_id=research_package_attempts.id AND l.file_id=research_package_attempts.file_id
        AND f.result_file_id=l.file_id AND f.result_location_id=l.location_id)`).bind(at,claim.id),
      db.prepare("UPDATE research_package_files SET state='published',updated_at=? WHERE job_id=? AND entry_kind<>'source' AND state='verified'").bind(at,claim.id),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE released_at IS NULL AND operation_id IN(
        SELECT id FROM research_package_attempts WHERE job_id=? AND state='published')`).bind(at,claim.id),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE released_at IS NULL AND operation_id IN(
        SELECT hold_operation_id FROM research_package_files WHERE job_id=? AND entry_kind='source')`).bind(at,claim.id),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE released_at IS NULL AND(operation_id=? OR operation_id LIKE ?)`)
        .bind(at,`fp4-source:${claim.id}`,`fp4-reuse:${claim.id}:%`),
      db.prepare(`UPDATE research_package_jobs SET state=?,phase=?,result_json=?,expires_at=?,updated_at=?,owner_token=NULL,lease_expires_at=NULL WHERE id=?`)
        .bind(claim.kind==="upload" ? "queued" : "completed",claim.kind==="upload" ? "validate" : "done",
          claim.kind==="upload" ? null : stableJson(result),expires,at,claim.id),
    ];
    if(statements.length>128) throw new Error("Package publication exceeds its bounded transaction");
    try { await db.batch(statements); } catch { /* Commit result and owned phase settle lost ACK; never repeat provider writes. */ }
    const committed=await this.job(claim.id);
    if(committed?.phase!==(claim.kind==="upload" ? "validate" : "done")) throw new Error("Package publication did not commit");
  }
  async control(id:string,actor:string,action:"pause"|"resume"|"cancel"|"retry"|"cleanup") {
    const job=await this.job(id); if(!job || job.actor!==actor) throw new Error("Package job is unavailable");
    const db=this.database.primary(),at=this.now();
    if(action==="cleanup") {
      const guard=await db.prepare("SELECT incarnation FROM file_job_runtime_guard WHERE singleton=1 AND enabled=1").first<{incarnation:string}>();
      if(!guard || !["completed","cancelled","preview"].includes(job.state)) throw new Error("Package cleanup is unavailable");
      await db.prepare(`INSERT INTO system_research_package_cleanup_grants(job_id,runtime_incarnation,requested_at,actor,mode) VALUES(?,?,?,?,'explicit')
        ON CONFLICT(job_id) DO UPDATE SET runtime_incarnation=excluded.runtime_incarnation,requested_at=excluded.requested_at,actor=excluded.actor,mode='explicit'`)
        .bind(id,guard.incarnation,new Date(this.clock().getTime()-120_000).toISOString(),actor).run();
    } else {
      if(["completed","cancelled"].includes(job.state)) return this.status(id,actor);
      const state=action==="pause" ? "paused" : action==="cancel" ? "cancel_requested" : "queued";
      await db.prepare(`UPDATE research_package_jobs SET state=?,generation=generation+1,owner_token=NULL,lease_expires_at=NULL,
        reason=?,updated_at=? WHERE id=? AND actor=? AND state NOT IN('completed','cancelled')`)
        .bind(state,action==="pause" ? "actor_paused" : null,at,id,actor).run();
    }
    return this.status(id,actor);
  }
  /** Cleanup releases only positively settled or never-started candidates.
   * Canonical retirement guards independently refuse any consumer or File hold. */
  async maintain(incarnation:string) {
    const db=this.database.primary(),at=this.now();
    const job=await db.prepare(`SELECT j.* FROM research_package_jobs j LEFT JOIN system_research_package_cleanup_grants g ON g.job_id=j.id
      WHERE j.state='cancel_requested' OR(g.runtime_incarnation=? AND j.state IN('completed','cancelled','preview')
      AND(g.mode='explicit' OR julianday(j.expires_at)<=julianday('now'))
      AND julianday(g.requested_at)<=julianday('now','-120 seconds')) ORDER BY j.updated_at,j.id LIMIT 1`)
      .bind(incarnation).first<PackageJob>();
    if(!job)return false;
    const progress=()=>db.prepare(`SELECT j.state,
      (SELECT count(*) FROM file_holds h WHERE h.operation_id=? AND h.released_at IS NULL) file_holds,
      (SELECT count(*) FROM file_location_holds h WHERE h.released_at IS NULL AND(h.operation_id=? OR h.operation_id LIKE ?
        OR h.operation_id IN(SELECT id FROM research_package_attempts WHERE job_id=?)
        OR h.operation_id IN(SELECT hold_operation_id FROM research_package_files WHERE job_id=? AND entry_kind='source'))) location_holds,
      (SELECT count(DISTINCT p.file_id) FROM file_publications p JOIN research_package_files f ON f.result_file_id=p.file_id
        WHERE f.job_id=? AND f.entry_kind<>'source' AND f.reuse_file_id IS NULL AND p.state='ready') publications
      FROM research_package_jobs j WHERE j.id=?`)
      .bind(`fp4-output:${job.id}`,`fp4-source:${job.id}`,`fp4-reuse:${job.id}:%`,job.id,job.id,job.id,job.id)
      .first<{state:string;file_holds:number;location_holds:number;publications:number}>();
    const before=await progress();
    const eligibility=`SELECT 1 FROM research_package_jobs j
      JOIN file_job_runtime_guard r ON r.singleton=1 AND r.enabled=1
      JOIN file_authority_runtime_guard fg ON fg.singleton=r.singleton AND fg.enabled=1
      JOIN file_authority_control fc ON fc.singleton=r.singleton AND fc.mode='active'
      LEFT JOIN system_research_package_cleanup_grants g ON g.job_id=j.id
      WHERE j.id=? AND j.state=? AND j.generation=? AND r.incarnation=?
      AND(j.state='cancel_requested' OR(g.runtime_incarnation=? AND j.state IN('completed','cancelled','preview')
        AND(g.mode='explicit' OR julianday(j.expires_at)<=julianday('now'))
        AND julianday(g.requested_at)<=julianday('now','-120 seconds')))`;
    const eligibilityValues=[job.id,job.state,job.generation,incarnation,incarnation];
    const progressed=(after:Awaited<ReturnType<typeof progress>>)=>Boolean(before&&after&&(
      (['preview','cancel_requested'].includes(before.state)&&after.state==='cancelled')
      ||before.file_holds>after.file_holds||before.location_holds>after.location_holds||before.publications>after.publications));
    const settled=`NOT EXISTS(SELECT 1 FROM research_package_attempts uncertain WHERE uncertain.job_id=?
      AND uncertain.write_started_at IS NOT NULL AND uncertain.io_settled_at IS NULL)`;
    const statements=[db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_job_runtime_guard g
      JOIN file_authority_runtime_guard fg ON fg.singleton=g.singleton AND fg.enabled=1
      JOIN file_authority_control fc ON fc.singleton=g.singleton AND fc.mode='active'
      WHERE g.singleton=1 AND g.enabled=1 AND g.incarnation=?) THEN 1 ELSE json('Package maintenance incarnation changed') END`).bind(incarnation),
      db.prepare(`SELECT CASE WHEN EXISTS(${eligibility}) THEN 1 ELSE json('Package cleanup eligibility changed') END`).bind(...eligibilityValues),
      db.prepare(`INSERT INTO system_research_package_cleanup_grants(job_id,runtime_incarnation,requested_at,actor,mode)
        VALUES(?,?,?,?,'explicit') ON CONFLICT(job_id) DO UPDATE SET requested_at=excluded.requested_at`)
        .bind(job.id,incarnation,at,job.actor),
      db.prepare(`UPDATE research_package_attempts SET state='cancelled',updated_at=? WHERE job_id=? AND state IN('staged','failed','write_started','unknown','verified')
        AND(io_settled_at IS NOT NULL OR write_started_at IS NULL)`).bind(at,job.id),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE released_at IS NULL AND operation_id IN(
        SELECT id FROM research_package_attempts WHERE job_id=? AND(io_settled_at IS NOT NULL OR write_started_at IS NULL))`).bind(at,job.id),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE released_at IS NULL AND operation_id IN(
        SELECT hold_operation_id FROM research_package_files WHERE job_id=? AND entry_kind='source') AND ${settled}`).bind(at,job.id,job.id),
      db.prepare(`UPDATE file_location_holds SET released_at=? WHERE released_at IS NULL AND(operation_id=? OR operation_id LIKE ?) AND ${settled}`)
        .bind(at,`fp4-source:${job.id}`,`fp4-reuse:${job.id}:%`,job.id),
      db.prepare(`UPDATE file_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM research_package_jobs dependent WHERE dependent.source_upload_job_id=? AND dependent.state NOT IN('completed','cancelled'))
        AND ${settled}`).bind(at,`fp4-output:${job.id}`,job.id,job.id),
      db.prepare(`UPDATE research_package_jobs SET state=CASE WHEN state IN('cancel_requested','preview') THEN 'cancelled' ELSE state END,
        expires_at=CASE WHEN kind<>'import' THEN ? ELSE expires_at END,updated_at=?,owner_token=NULL,lease_expires_at=NULL WHERE id=?`).bind(at,at,job.id),
      db.prepare(`UPDATE file_publications SET state='retired',active_location_id=NULL,retired_at=? WHERE state='ready'
        AND file_id IN(SELECT f.result_file_id FROM research_package_files f JOIN research_package_jobs j ON j.id=f.job_id
          WHERE j.id=? AND(f.entry_kind='artifact' OR(j.kind='import' AND j.state='cancelled' AND f.reuse_file_id IS NULL)))
        AND NOT EXISTS(SELECT 1 FROM file_retention_edges e WHERE e.file_id=file_publications.file_id)
        AND NOT EXISTS(SELECT 1 FROM file_holds h WHERE h.file_id=file_publications.file_id AND h.released_at IS NULL
          AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
        AND NOT EXISTS(SELECT 1 FROM file_location_holds h JOIN file_locations l ON l.id=h.location_id
          WHERE l.file_id=file_publications.file_id AND h.released_at IS NULL AND(h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
        AND ${settled}`).bind(at,job.id,job.id),
      db.prepare(`DELETE FROM system_research_package_cleanup_grants WHERE job_id=? AND NOT EXISTS(
        SELECT 1 FROM file_holds h WHERE h.operation_id=? AND h.released_at IS NULL) AND NOT EXISTS(
        SELECT 1 FROM file_location_holds h JOIN research_package_attempts a ON a.id=h.operation_id WHERE a.job_id=? AND h.released_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM file_publications p JOIN research_package_files f ON f.result_file_id=p.file_id
          WHERE f.job_id=? AND f.entry_kind='artifact' AND p.state='ready')`)
        .bind(job.id,`fp4-output:${job.id}`,job.id,job.id)];
    try{await db.batch(statements);}catch(error){
      // A newer owner/control operation invalidates this selection. Do not
      // clear that owner's lease or release its holds. Positive fresh facts
      // still settle an acknowledgement lost after our own atomic commit.
      if(progressed(await progress()))return true;
      if(!await db.prepare(eligibility).bind(...eligibilityValues).first())return false;
      throw error;
    }
    const after=await progress();
    // Retried cleanup metadata alone is not an executor action. A blocked
    // candidate or retained output must let a queued job use this cadence slot.
    return progressed(after);
  }
}
