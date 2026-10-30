import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { checkedResearchJobStatus, checkedResearchPackagePreview, checkedResearchRequestReceipt, type ResearchJobStatus } from "../../shared/contracts/research-package-api";
import { validateCommentAcceptedItemResult } from "../../shared/contracts/comment-acceptance";
import { RESEARCH_PACKAGE_CATALOG, RESEARCH_EVENT_RELATIONSHIP_FIELDS, type ResearchRecordKind } from "../../shared/contracts/research-package-catalog";
import { researchRecordsDocument, validateResearchPackage, type ResearchPackageV1 } from "../../shared/contracts/research-package";
import { stableJson } from "../../shared/domain/content-addressing";
import { createStoreArchiveStream, measureStoreArchive, sourceFromBlob, validateStoreArchive, type ArchiveEntry } from "../../shared/domain/research-archive";
import { buildImportDomainFixture } from "../../worker/packages/import-domain-test-support";
import { REFERENCE_IMPORT_KINDS, type ImportIdentityKind } from "../../worker/packages/import-domain-identity";
import type { FrozenImportDomainPlan } from "../../worker/packages/import-domain-types";
import { fixture, actor } from "../files/jobs/local-runtime.qualification-support";
import { pairJson, type GenuineR2Pair } from "../recovery/current-v26-r2-node-pair.qualification-support";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Binding = string | number | null;
export type PackageRows = (sql: string, bindings?: readonly Binding[]) => Promise<Record<string, unknown>[]>;
export interface PackagePeer {
  readonly provider: "r2" | "local"; readonly actor: string;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; value: unknown; headers: Headers }>;
  rows: PackageRows; emit(): Promise<void>; verifyIntegrity(): Promise<void>;
}
const prefix = "/api/packages";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function ensure(value: unknown): asserts value { if (!value) throw new Error("Genuine public Package pair observation unavailable"); }
export function nodePackagePeer(f: Fixture): PackagePeer {
  return { provider: "local", actor,
    request: f.request,
    async rows(sql, bindings = []) { return f.native.prepare(sql).all(...bindings) as Record<string, unknown>[]; },
    async emit() { expect((await f.dispatchJobsOnce()).outcome).not.toBe("paused"); },
    async verifyIntegrity() { expect(f.native.prepare("PRAGMA integrity_check").all().map(row => Object.values(row)[0])).toEqual(["ok"]); },
  };
}
export function r2PackagePeer(pair: GenuineR2Pair): PackagePeer {
  return { provider: "r2", actor: pair.actor,
    async request(method, path, body, headers = {}) {
      const binary = body instanceof Uint8Array;
      const result = await pair.request(path, method, body === undefined ? undefined : binary ? body.slice().buffer as ArrayBuffer : JSON.stringify(body),
        { ...(body === undefined || binary ? {} : { "content-type": "application/json" }), ...headers });
      ensure(result.value instanceof ArrayBuffer);
      const type = result.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      return { status: result.response.status, headers: result.response.headers,
        value: type === "application/zip" ? new Uint8Array(result.value) : result.value.byteLength ? pairJson(result.value) : null };
    },
    rows: pair.readRows,
    emit: pair.schedule,
    verifyIntegrity: pair.verifyNativeDatabaseConsistency,
  };
}
export async function released(peer: PackagePeer) {
  expect((await peer.rows("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL"))[0]?.n).toBe(0);
  expect(await peer.rows("PRAGMA foreign_key_check")).toEqual([]);
  await peer.verifyIntegrity();
}
/** Real ordinary completed business upload and released public control routes.
 * Every epoch/profile/receipt comes from this genuine Access+D1 owner. */
export async function activateR2PackagePeer(pair: GenuineR2Pair) {
  const peer = r2PackagePeer(pair);
  async function request(method: string, path: string, body?: unknown, status = 200) {
    const answer = await peer.request(method, path, body);
    let label = path;
    if (answer.status !== status) {
      const value = answer.value;
      const publicError = value && typeof value === "object" && !Array.isArray(value)
        && typeof (value as Record<string, unknown>).error === "string"
        ? String((value as Record<string, unknown>).error).slice(0, 2048) : null;
      label = `${method} ${path}: HTTP ${answer.status}; public response.error=${JSON.stringify(publicError)}`;
    }
    expect(answer.status, label).toBe(status); return answer.value as Record<string, unknown>;
  }
  expect(await pair.legacyMode()).toEqual({ mode: "legacy" });
  expect(await peer.rows("SELECT id FROM storage_profiles")).toEqual([]);
  expect((await pair.listObjects()).objects).toEqual([]);
  expect((await pair.request("/api/files/shadow/evidence/capabilities", "GET", undefined, {}, "none")).response.status).toBe(403);
  const operator = await request("GET", "/api/files/shadow/evidence/capabilities"); expect(operator.canAdjudicate).toBe(true);
  const bootstrapBytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRXsAAAAASUVORK5CYII=', 'base64'));
  const bootstrapSha256 = hash(bootstrapBytes);
  const sample = await request("POST", "/api/samples", { code: `PAIR-BOOTSTRAP-${randomUUID()}`, title: "Genuine completed bootstrap image" }, 201);
  ensure(typeof sample.id === "string");
  const sampleRows = await peer.rows("SELECT id,updated_at,created_by FROM samples WHERE id=?", [sample.id]);
  expect(sampleRows).toHaveLength(1); expect(sampleRows[0]?.created_by).toBe(pair.actor);
  ensure(typeof sampleRows[0]?.updated_at === "string");
  const submissionId = randomUUID(), itemId = randomUUID();
  const accepted = await request("POST", "/api/comment-submissions", { protocol: "comment-submission/1", id: submissionId,
    body: "Retain this genuine completed bootstrap image through public File shadow conversion",
    context: { kind: "sample", sampleId: sample.id, expectedUpdatedAt: sampleRows[0].updated_at },
    items: [{ id: itemId, kind: "comment_image", filename: "genuine-bootstrap.png", mimeType: "image/png", byteSize: bootstrapBytes.byteLength,
      originalFilename: "genuine-bootstrap.png", originalMimeType: "image/png", originalByteSize: bootstrapBytes.byteLength,
      sha256: bootstrapSha256 }] }, 201);
  expect(accepted.request).toMatchObject({ status: "pending", items: [{ id: itemId, status: "pending" }] });
  const uploaded = await peer.request("PUT", `/api/comment-submissions/${submissionId}/items/${itemId}/content`, bootstrapBytes,
    { "content-type": "image/png", "x-upload-size": String(bootstrapBytes.byteLength), "x-content-sha256": bootstrapSha256 });
  expect(uploaded.status).toBe(200); expect(uploaded.value).toMatchObject({ ok: true, request: { status: "pending", items: [{ id: itemId, status: "ready" }] } });
  const readyItem = (await peer.rows("SELECT status,actor_email,accepted_result_json FROM comment_item_acceptances WHERE item_id=? AND submission_id=?", [itemId,submissionId]))[0]; ensure(readyItem);
  expect(readyItem).toMatchObject({ status: "ready", actor_email: pair.actor });
  const originalResult = validateCommentAcceptedItemResult(JSON.parse(String(readyItem.accepted_result_json)));
  expect(originalResult).toMatchObject({ storeKind: "r2", provider: "r2", sha256: bootstrapSha256, byteSize: bootstrapBytes.byteLength });
  const legacyBytes = await pair.readObject(originalResult.objectKey);
  expect(legacyBytes.byteSize).toBe(bootstrapBytes.byteLength); expect(new Uint8Array(legacyBytes.bytes)).toEqual(bootstrapBytes);
  expect(hash(new Uint8Array(legacyBytes.bytes))).toBe(bootstrapSha256);
  const finalized = await request("POST", `/api/comment-submissions/${submissionId}/finalize`);
  expect(finalized).toMatchObject({ ok: true, status: "ready", request: { status: "ready", items: [{ id: itemId, status: "ready" }] } });
  const receipts = await peer.rows(`SELECT cs.id,cs.actor_email,cs.status canonical_status,ca.status acceptance_status,
    ca.completed_at,csi.id item_id,csi.status item_status,ia.status item_acceptance_status,ia.execution_token,
    csi.asset_id,csi.file_id,ia.expected_sha256,ia.expected_byte_size,ia.accepted_result_json
    FROM comment_submissions cs JOIN comment_submission_acceptances ca ON ca.submission_id=cs.id
    JOIN comment_submission_items csi ON csi.submission_id=cs.id JOIN comment_item_acceptances ia ON ia.item_id=csi.id WHERE cs.id=?`, [submissionId]);
  expect(receipts).toHaveLength(1); expect(receipts[0]).toMatchObject({ id: submissionId, actor_email: pair.actor,
    canonical_status: "ready", acceptance_status: "ready", item_id: itemId, item_status: "ready", item_acceptance_status: "ready",
    asset_id: originalResult.blobRecordId, file_id: null, expected_sha256: bootstrapSha256, expected_byte_size: bootstrapBytes.byteLength });
  ensure(typeof receipts[0]?.completed_at === "string"); ensure(typeof receipts[0]?.execution_token === "string");
  const initialObjects = await pair.listObjects(); expect(initialObjects.truncated).toBe(false);
  expect(initialObjects.objects.map(row=>row.key)).toEqual([originalResult.objectKey]);
  const profiles = await peer.rows("SELECT id,adapter_type,configuration_revision,configuration_source,namespace_identity FROM storage_profiles");
  expect(profiles).toHaveLength(1); expect(profiles[0]).toMatchObject({ adapter_type: "r2", configuration_revision: 1, configuration_source: "bootstrap" });
  ensure(typeof profiles[0]?.id === "string"); const profileId = profiles[0].id;
  let shadow = await request("GET", "/api/files/shadow/status");
  expect(shadow).toMatchObject({ mode: "legacy", enabled: 0, current_count: 1, pending_count: 1, unfinished_attempts: 0 });
  const incarnation = randomUUID();
  shadow = await request("POST", "/api/files/shadow/enable", { requestId: incarnation, expectedEpoch: shadow.epoch, expectedIncarnation: shadow.incarnation });
  expect(shadow).toMatchObject({ mode: "overlap", enabled: 1, incarnation });
  shadow = await request("POST", "/api/files/shadow/profiles/enable", { profile: { profileId, configurationRevision: 1 }, runtimeIncarnation: incarnation, expectedEpoch: shadow.epoch });
  expect(shadow).toMatchObject({ enabled: 1, incarnation, current_count: 1, pending_count: 1 });
  const key = { consumerKind: "comment_submission_item", consumerId: itemId, consumerSubId: "", fileSlot: "primary" };
  const baseline = await request("POST", "/api/files/shadow/baseline", { key });
  expect(baseline).toMatchObject({ status: "ready_to_verify", purpose: "embedded_content", bytesVerified: false,
    head: { present: 1, consumer_kind: "comment_submission_item", consumer_id: itemId },
    sourceLocator: { storeKind: "r2", provider: "r2", objectKey: originalResult.objectKey },
    sourceProfile: { profileId, configurationRevision: 1 } });
  ensure(typeof baseline.baselineSha256 === "string");
  const conversionInput = { operationId: randomUUID(), key, expectedBaselineSha256: baseline.baselineSha256,
    destinationProfile: { profileId, configurationRevision: 1 }, runtimeIncarnation: incarnation };
  const conversion = await request("POST", "/api/files/shadow/convert", conversionInput);
  expect(conversion).toMatchObject({ operationId: conversionInput.operationId, status: "resolved", attemptState: "published", nextAction: "none" });
  ensure(typeof conversion.fileId === "string" && typeof conversion.locationId === "string");
  const conversionReadback = await request("POST", "/api/files/shadow/operation", { operationId: conversionInput.operationId, runtimeIncarnation: incarnation });
  expect(conversionReadback).toEqual(conversion);
  const publication = (await peer.rows(`SELECT f.file_id,f.purpose,f.verified_sha256,f.verified_byte_size,l.location_id,l.storage_profile_id,l.object_key
    FROM file_usable_publications f JOIN file_location_publications l ON l.location_id=f.active_location_id WHERE f.file_id=?`, [conversion.fileId]))[0]; ensure(publication);
  expect(publication).toMatchObject({ file_id: conversion.fileId, purpose: "embedded_content", verified_sha256: bootstrapSha256,
    verified_byte_size: bootstrapBytes.byteLength, location_id: conversion.locationId, storage_profile_id: profileId });
  ensure(typeof publication.object_key === "string"); expect(publication.object_key).not.toBe(originalResult.objectKey);
  const convertedBytes = await pair.readObject(publication.object_key);
  expect(convertedBytes.byteSize).toBe(bootstrapBytes.byteLength); expect(new Uint8Array(convertedBytes.bytes)).toEqual(bootstrapBytes);
  expect(hash(new Uint8Array(convertedBytes.bytes))).toBe(bootstrapSha256);
  shadow = await request("GET", "/api/files/shadow/status");
  expect(shadow).toMatchObject({ mode: "overlap", enabled: 1, incarnation, current_count: 1, resolved_count: 1, unresolved_count: 0,
    pending_count: 0, unfinished_attempts: 0 });
  const checkpointId = randomUUID();
  const checkpoint = await request("POST", "/api/files/shadow/checkpoint", { requestId: checkpointId, expectedEpoch: shadow.epoch, runtimeIncarnation: incarnation });
  expect(checkpoint).toMatchObject({ id: checkpointId, current_count: 1, resolved_count: 1, unresolved_count: 0, pending_count: 0, captured_by: pair.actor });
  shadow = await request("POST", "/api/files/shadow/disable", { runtimeIncarnation: incarnation, expectedEpoch: shadow.epoch });
  expect(shadow.enabled).toBe(0);
  const cutoff = await request("GET", "/api/files/authority/status");
  expect(cutoff).toMatchObject({ mode: "overlap", enabled: 0, shadow_enabled: 0, shadow_incarnation: incarnation,
    current_count: 1, resolved_count: 1, pending_receipts: 0, unattached_ready_uploads: 0, unpublished_candidates: 0, unfinished_attempts: 0 });
  const authorityId = randomUUID();
  const authority = await request("POST", "/api/files/authority/activate", { requestId: authorityId, expectedEpoch: cutoff.epoch, expectedShadowIncarnation: incarnation });
  expect(authority).toMatchObject({ mode: "active", enabled: 1, incarnation: authorityId, current_count: 1, resolved_count: 1,
    pending_receipts: 0, unfinished_attempts: 0 });
  const activeItem = (await peer.rows("SELECT file_id,status,asset_id FROM comment_submission_items WHERE id=?", [itemId]))[0];
  expect(activeItem).toEqual({ file_id: conversion.fileId, status: "ready", asset_id: originalResult.blobRecordId });
  const roleOperationId = randomUUID();
  const policy = await request("PUT", "/api/settings/storage/defaults", { operationId: roleOperationId, expectedPolicyRevision: null, internalProfileId: profileId, originalsProfileId: profileId });
  expect(policy).toMatchObject({ operationId: roleOperationId, internalProfileId: profileId, originalsProfileId: profileId, createdBy: pair.actor });
  const executor = await request("POST", "/api/files/migrations/executor", { enabled: true }); expect(executor.enabled).toBe(true);
  expect((await peer.rows("SELECT state FROM storage_profile_runtime WHERE storage_profile_id=?", [profileId]))[0]?.state).toBe("read_write");
  await released(peer);
  console.info("PACKAGE_PAIR_PHASE_V1 genuine_public_activation_completed");
  return { peer, profileId, sampleId: sample.id, submissionId, itemId, receipts, profiles, originalResult, baseline, conversionInput, conversion, conversionReadback, publication, activeItem, checkpoint, cutoff, authority, policy, executor };
}

export async function packageFixtureArchive(){
  const value=await buildImportDomainFixture(),{records,...manifest}=value.package,encode=new TextEncoder();
  const contents=new Map<string,Uint8Array>([["manifest.json",encode.encode(stableJson(manifest))],
    ["records.json",encode.encode(stableJson(researchRecordsDocument(records)))],
    ["report/index.html",encode.encode("<!doctype html><p>Inert qualification report</p>")],
    ["report/report.md",encode.encode("# Qualification report")],
    ...value.package.files.map(file=>[file.path,value.payloads.get(file.packageFileId)!] as const)]);
  const entries:ArchiveEntry[]=[...contents].map(([path,bytes])=>({path,kind:path.startsWith("files/")?"payload":path.startsWith("report/")?"report":"metadata",byteSize:bytes.byteLength,sha256:hash(bytes)}));
  const open=async(entry:ArchiveEntry)=>new Response(contents.get(entry.path)!.slice().buffer as ArrayBuffer).body!;
  const measured=await measureStoreArchive(entries,open);
  const bytes=new Uint8Array(await new Response(createStoreArchiveStream(entries,open)).arrayBuffer());
  expect(bytes.byteLength).toBe(measured.byteSize);expect(hash(bytes)).toBe(measured.sha256);
  return{value,bytes,measured};
}

export async function assertCopiedPackageGraph(read: PackageRows, jobId: string, original: ResearchPackageV1){
  const row=(await read("SELECT domain_plan_json FROM research_package_jobs WHERE id=?", [jobId]))[0]!;
  const frozen=JSON.parse(String(row.domain_plan_json)) as FrozenImportDomainPlan;
  const identities=await read("SELECT entity_kind,source_id,destination_id FROM research_package_identity_maps WHERE job_id=? ORDER BY entity_kind,source_id", [jobId]);
  const mapped=(kind:ImportIdentityKind,id:string)=>{
    const identity=identities.find(value=>value.entity_kind===kind&&value.source_id===id);
    expect(identity,`${kind}:${id}`).toBeDefined();return String(identity!.destination_id);
  };
  const acceptedIdentities=identities.map(identity=>({kind:identity.entity_kind,sourceId:identity.source_id,destinationId:identity.destination_id}));
  expect(acceptedIdentities).toHaveLength(frozen.identities.length);
  expect(acceptedIdentities).toEqual(expect.arrayContaining(frozen.identities));
  for(const published of frozen.rows){
    const fields=RESEARCH_PACKAGE_CATALOG[published.kind].id;
    const actual=(await read(`SELECT * FROM ${published.table} WHERE ${fields.map(field=>`${field}=?`).join(" AND ")}`, fields.map(field=>published.data[field] as Binding)))[0];
    expect(actual,`${published.kind}:${published.sourceId}`).toMatchObject(published.data);
    if(fields.length===1&&fields[0]==='id')expect(published.id).not.toBe(published.sourceId);
  }
  const retained=await read("SELECT record_json FROM research_package_records WHERE job_id=? ORDER BY ordinal", [jobId]);
  expect(retained.map(value=>JSON.parse(String(value.record_json)))).toEqual(original.records);
  expect(retained).toHaveLength(original.counts.records);
  const nativeRows=new Map<string,Record<string,unknown>>();
  for(const source of original.records){
    if(source.kind==='fileDerivation'||source.kind==='attachmentDerivative')continue;
    const definition=RESEARCH_PACKAGE_CATALOG[source.kind];
    const parts=definition.id.map(field=>{
      if(field==='id'||field==='hash')return mapped(source.kind,source.sourceId);
      const relation=definition.relations?.find(value=>value.field===field);
      return relation?mapped(relation.kind,String(source.data[field])):source.data[field] as string|number|null;
    });
    const actual=(await read(`SELECT * FROM ${definition.table} WHERE ${definition.id.map(field=>`${field}=?`).join(' AND ')}`, parts))[0]!;
    expect(actual,`${source.kind}:${source.sourceId}`).toBeDefined();nativeRows.set(`${source.kind}:${source.sourceId}`,actual);
    if(definition.id.length===1&&definition.id[0]==='id'){expect(actual.id).toBe(mapped(source.kind,source.sourceId));expect(actual.id).not.toBe(source.sourceId);}
    // Compare ordinary source fields directly to actual canonical cells, rather
    // than to the formatter's own expected rows. Only declared typed identities,
    // accepted naming and public JSON projection fields need separate checks.
    const typed=new Set([...(definition.relations??[]).map(value=>value.field),
      'last_mutation_id','deletion_operation_id','asset_deletion_operation_id','supersession_operation_id','creation_operation_id',
      'run_group_id','operation_group_id','metadata','relationships','target','contexts','excluded_targets']);
    for(const [field,value] of Object.entries(source.data)){
      if(typed.has(field)||field==='packageFileId'||field.endsWith('PackageFileId')||!Object.hasOwn(actual,field))continue;
      const naming=frozen.naming.find(value=>value.kind===source.kind&&value.sourceId===source.sourceId&&value.field===field);
      if(naming){expect(naming.original).toBe(value);expect(actual[field]).toBe(naming.destination);continue;}
      const observed=definition.fields[field].type==='json'&&actual[field]!==null?JSON.parse(String(actual[field])):actual[field];
      expect(observed,`${source.kind}:${source.sourceId}.${field}`).toEqual(value);
    }
    for(const field of ['last_mutation_id','deletion_operation_id','asset_deletion_operation_id','supersession_operation_id','creation_operation_id'])
      if(Object.hasOwn(source.data,field)&&Object.hasOwn(actual,field))expect(actual[field]).toBe(source.data[field]===null?null:mapped('operation',String(source.data[field])));
    if(Object.hasOwn(source.data,'run_group_id'))expect(actual.run_group_id).toBe(source.data.run_group_id===null?null:mapped('group',String(source.data.run_group_id)));
    for(const relation of definition.relations??[]){
      const value=source.data[relation.field];
      expect(actual[relation.field],`${source.kind}:${source.sourceId}.${relation.field}`)
        .toBe(value===null?null:mapped(relation.kind,String(value)));
    }
  }
  const copied=(kind:ResearchRecordKind,sourceId:string)=>nativeRows.get(`${kind}:${sourceId}`)!;
  const sources=(kind:ResearchRecordKind)=>original.records.filter(value=>value.kind===kind);
  expect(sources('comment')).toHaveLength(1);expect(sources('commentTarget')).toHaveLength(2);
  expect(copied('comment',sources('comment')[0].sourceId).body).toBe('One canonical Common Comment body');
  for(const source of sources('commentOccurrence')){
    const actual=copied(source.kind,source.sourceId);
    expect(actual.operation_group_id).toBe(source.data.operation_group_id===null?null:mapped('comment',String(source.data.operation_group_id)));
    expect(actual.legacy_body).toBe(source.data.legacy_body);
  }
  const references=sources('reference');expect(references).toHaveLength(9);
  for(const source of references){
    const actual=copied(source.kind,source.sourceId),target=source.data.target as {kind:ResearchRecordKind;sourceId:string};
    expect(actual.target_type).toBe(Object.entries(REFERENCE_IMPORT_KINDS).find(([,kind])=>kind===target.kind)![0]);
    expect(actual.target_id).toBe(mapped(target.kind,target.sourceId));
    const contexts=source.data.contexts as Array<{segments:Array<{target:{kind:ResearchRecordKind;sourceId:string};label:string;deletedAt:null|string;archivedAt:null|string}>}>;
    expect(JSON.parse(String(actual.last_known_contexts_json))).toEqual(contexts.map(context=>({segments:context.segments.map(segment=>({
      type:Object.entries(REFERENCE_IMPORT_KINDS).find(([,kind])=>kind===segment.target.kind)![0],id:mapped(segment.target.kind,segment.target.sourceId),
      label:segment.label,deletedAt:segment.deletedAt,archivedAt:segment.archivedAt,
    }))})));
  }
  const placements=sources('projectPlacement');expect(placements).toHaveLength(11);
  for(const source of placements)expect(copied(source.kind,source.sourceId)).toMatchObject({
    project_item_id:mapped('projectItem',String(source.data.project_item_id)),x:source.data.x,y:source.data.y,width:source.data.width,height:source.data.height,
    z_index:source.data.z_index,revision:source.data.revision,
  });
  expect(copied('projectContent',sources('projectContent').find(source=>source.data.content_type==='attachment')!.sourceId)).toMatchObject({deleted_at:sources('projectContent').find(source=>source.data.content_type==='attachment')!.data.deleted_at,attachment_caption:'Deleted attachment history'});
  expect(copied('projectItem',sources('projectItem').find(source=>source.data.project_content_id===sources('projectContent').find(value=>value.data.content_type==='attachment')!.sourceId)!.sourceId).deleted_at).toBe(sources('projectItem').find(source=>source.data.deleted_at!==null)!.data.deleted_at);
  expect(copied('projectEdge',sources('projectEdge').find(source=>source.data.deleted_at!==null)!.sourceId)).toMatchObject({deleted_at:sources('projectEdge').find(source=>source.data.deleted_at!==null)!.data.deleted_at,label:'Preserved cyclic graph edge'});
  expect(copied('sample',sources('sample')[0].sourceId).title).toBe('foreign-run-one remains literal title');
  expect(copied('runStep',sources('runStep').find(source=>source.data.notes==='foreign-step-two is literal history text')!.sourceId).notes).toBe('foreign-step-two is literal history text');
  const definition=sources('stepDefinition')[0],state=sources('state')[0];
  expect(mapped('stepDefinition',definition.sourceId)).toBe(definition.sourceId);expect(mapped('state',state.sourceId)).toBe(state.sourceId);
  expect(copied('stepDefinition',definition.sourceId)).toMatchObject({hash:definition.sourceId,
    parameters_text:'foreign-run-one is ordinary parameter text',comments_text:'Original researcher note'});
  expect(JSON.parse(String(copied('stepDefinition',definition.sourceId).canonical_json))).toEqual(definition.data.canonical_json);
  expect(copied('state',state.sourceId).hash).toBe(state.sourceId);
  expect(JSON.parse(String(copied('state',state.sourceId).content_json))).toEqual(state.data.content_json);
  const ordered=sources('stateAsset').sort((left,right)=>Number(left.data.position)-Number(right.data.position)).map(source=>copied(source.kind,source.sourceId));
  expect(ordered.map(value=>value.position)).toEqual([0,1]);expect(ordered[0].asset_id).not.toBe(ordered[1].asset_id);expect(ordered[0].file_id).not.toBe(ordered[1].file_id);
  const fileMap=await read("SELECT logical_file_id,result_file_id,candidate_asset_id FROM research_package_files WHERE job_id=? AND entry_kind='payload'", [jobId]);
  const metadata=JSON.parse(String(copied('event',sources('event')[0].sourceId).metadata_json));
  expect(copied('event',sources('event')[0].sourceId).body).toBe('foreign-run-one remains ordinary event text');
  expect(metadata.rawCells).toEqual({stepId:'foreign-step-one'});expect(metadata.caption).toBe('Original <b>caption</b>');
  const relationships=sources('event')[0].data.relationships as Array<{field:string;target:{kind:ImportIdentityKind;sourceId:string}}>;
  const runRelationship=relationships.find(value=>value.field==='runId')!;
  expect(metadata.runId).toBe(mapped(runRelationship.target.kind,runRelationship.target.sourceId));
  expect(metadata.stepIds).toEqual(relationships.filter(value=>/^stepIds\[\d+\]$/.test(value.field))
    .sort((left,right)=>Number(left.field.slice(8,-1))-Number(right.field.slice(8,-1)))
    .map(value=>mapped(value.target.kind,value.target.sourceId)));
  expect(copied('projectContent',sources('projectContent').find(source=>source.data.content_type==='markdown')!.sourceId).markdown_source).toBe('# Original Markdown\n\nforeign-run-one remains user text.');
  // Compare complete typed historical JSON against source records and actual
  // durable identity/File receipts; user prose and nested raw cells stay literal.
  for(const source of sources('event')){
    const expected={...(source.data.metadata as Record<string,unknown>)};
    const arrays=new Map<string,Map<number,string>>();
    for(const relation of source.data.relationships as Array<{field:string;target:{kind:ImportIdentityKind;sourceId:string}}>){
      const match=/^([A-Za-z][A-Za-z0-9]*)(?:\[(\d+)\])?$/.exec(relation.field);ensure(match);
      const identity=mapped(relation.target.kind,relation.target.sourceId);
      if(match[2]===undefined)expected[match[1]]=identity;
      else{let values=arrays.get(match[1]);if(!values)arrays.set(match[1],values=new Map());values.set(Number(match[2]),identity);}
    }
    for(const [field,values] of arrays)expected[field]=Array.from({length:values.size},(_,index)=>values.get(index));
    for(const [field,column] of [['packageFileId','assetId'],['thumbnailPackageFileId','thumbnailAssetId']] as const)
      if(source.data[field]!==null){const file=fileMap.find(value=>value.logical_file_id===source.data[field]);ensure(file);expected[column]=file.candidate_asset_id;}
    expect(JSON.parse(String(copied('event',source.sourceId).metadata_json))).toEqual(expected);
  }


  const slots:Array<[ResearchRecordKind,string,string]>=[['stateAsset','packageFileId','file_id'],['executionImage','packageFileId','file_id'],
    ['metrologyReference','packageFileId','file_id'],['commentOccurrence','packageFileId','file_id'],['stateVerification','evidencePackageFileId','evidence_file_id'],
    ['commentItem','packageFileId','file_id'],['projectAttachment','packageFileId','file_id'],['recipeRevision','sourcePackageFileId','source_file_id'],
    ['sourceImport','workbookPackageFileId','workbook_file_id'],['sourceImport','manifestPackageFileId','manifest_file_id'],
    ['event','packageFileId','asset_file_id'],['event','thumbnailPackageFileId','thumbnail_file_id'],['attachmentDerivative','derivedPackageFileId','']];
  for(const [kind,field,column] of slots){
    const records=sources(kind).filter(value=>typeof value.data[field]==='string');expect(records.length,`${kind}.${field}`).toBeGreaterThan(0);
    for(const source of records){
      const file=fileMap.find(value=>value.logical_file_id===source.data[field]);expect(file).toBeDefined();
      if(column)expect(copied(kind,source.sourceId)[column],`${kind}.${field}`).toBe(file!.result_file_id);
      else{
        expect(source.data.trust_state).toBe('imported_unverified');
        expect((await read('SELECT file_id FROM file_usable_publications WHERE file_id=?', [file!.result_file_id as Binding]))[0]).toBeDefined();
      }
    }
  }
  const sourceImport=copied('sourceImport',sources('sourceImport')[0].sourceId);
  for(const field of ['operation_id','lease_expires_at','finalization_id','recovery_operation_id','client_request_id','request_sha256','request_input_json','request_scope',
    'storage_profile_id','storage_profile_revision','storage_policy_revision','accepted_result_json','file_targets_protocol','role_policy_revision'])expect(sourceImport[field],field).toBeNull();
  for(const kind of ['fileDerivation','attachmentDerivative'] as const)expect(sources(kind)[0].data.trust_state).toBe('imported_unverified');
  expect((await read('SELECT count(*) n FROM file_derivations'))[0]?.n).toBe(0);expect((await read('SELECT count(*) n FROM attachment_derivatives'))[0]?.n).toBe(0);
  expect(await read('PRAGMA foreign_key_check')).toEqual([]);expect((await read('PRAGMA defer_foreign_keys'))[0]).toEqual({defer_foreign_keys:0});
}
export function serializedSlots(pkg:ResearchPackageV1){
  const slots:Array<[ResearchRecordKind,string]>=[['stateAsset','packageFileId'],['executionImage','packageFileId'],['metrologyReference','packageFileId'],
    ['commentOccurrence','packageFileId'],['stateVerification','evidencePackageFileId'],['commentItem','packageFileId'],['projectAttachment','packageFileId'],
    ['recipeRevision','sourcePackageFileId'],['sourceImport','workbookPackageFileId'],['sourceImport','manifestPackageFileId'],
    ['event','packageFileId'],['event','thumbnailPackageFileId'],['attachmentDerivative','derivedPackageFileId']];
  for(const [kind,field] of slots){const values=pkg.records.filter(record=>record.kind===kind&&typeof record.data[field]==='string');
    expect(values.length,`${kind}.${field}`).toBeGreaterThan(0);for(const value of values)expect(pkg.files.some(file=>file.packageFileId===value.data[field])).toBe(true);}
  for(const kind of ['fileDerivation','attachmentDerivative'] as const)expect(pkg.records.find(record=>record.kind===kind)!.data.trust_state).toBe('imported_unverified');
}

export async function drainPackage(peer: PackagePeer, jobId: string, expected: "preview" | "completed"): Promise<ResearchJobStatus> {
  for (let iteration = 0; iteration < 36; iteration++) {
    const answer = await peer.request("GET", `${prefix}/jobs/${jobId}`); expect(answer.status).toBe(200);
    const job = checkedResearchJobStatus(answer.value);
    if (job.state === expected) return job;
    expect(["queued", "running", "preview", "awaiting_upload"]).toContain(job.state);
    await peer.emit();
  }
  throw new Error("Original bounded Package emitter did not reach its checkpoint");
}
export async function importPackage(peer: PackagePeer, bytes: Uint8Array, pkg: ResearchPackageV1) {
  const uploadRequest = { requestId: randomUUID(), byteSize: bytes.byteLength, sha256: hash(bytes) };
  const accepted = await peer.request("POST", `${prefix}/uploads`, uploadRequest); expect(accepted.status).toBe(202);
  const uploaded = checkedResearchRequestReceipt(accepted.value);
  expect(uploaded.job.state).toBe("awaiting_upload");
  const sent = await peer.request("PUT", `${prefix}/jobs/${uploaded.job.id}/upload`, bytes,
    { "content-type": "application/zip", "content-length": String(bytes.byteLength) }); expect(sent.status).toBe(200);
  await drainPackage(peer, uploaded.job.id, "preview");
  const previewAnswer = await peer.request("GET", `${prefix}/jobs/${uploaded.job.id}/preview`); expect(previewAnswer.status).toBe(200);
  const preview = checkedResearchPackagePreview(previewAnswer.value);
  expect(preview).toMatchObject({ complete: true, counts: { files: 15 }, capabilities: { dataPackage: { available: true } },
    source: { installationId: pkg.sourceInstallationId, packageId: pkg.packageId, payloadSha256: hash(bytes) } });
  ensure(preview.rolePolicyRevision !== null);
  const input = { requestId: randomUUID(), uploadJobId: uploaded.job.id, anotherCopy: false, expectedRolePolicyRevision: preview.rolePolicyRevision };
  const answer = await peer.request("POST", `${prefix}/imports`, input); expect(answer.status).toBe(202);
  const receipt = checkedResearchRequestReceipt(answer.value); expect(receipt.job.state).toBe("queued");
  const job = await drainPackage(peer, receipt.job.id, "completed");
  expect(job.progress).toMatchObject({ completedFiles: 15, totalFiles: 15 }); expect(job.result?.roots).toHaveLength(2);
  expect((await peer.rows("SELECT actor,package_id,source_installation_id FROM research_package_jobs WHERE id=?", [job.id]))[0])
    .toEqual({ actor: peer.actor, package_id: pkg.packageId, source_installation_id: pkg.sourceInstallationId });
  await assertCopiedPackageGraph(peer.rows, job.id, pkg);
  const replay = await peer.request("POST", `${prefix}/imports`, input); expect(replay.status).toBe(202);
  expect(checkedResearchRequestReceipt(replay.value).job.id).toBe(job.id);
  await released(peer);
  return { job, input, preview, uploadRequest, uploadJobId: uploaded.job.id };
}
export async function importedPackageFiles(peer: PackagePeer, jobId: string, pkg: ResearchPackageV1, expected: Map<string, Uint8Array>, pair?: GenuineR2Pair) {
  const rows = await peer.rows(`SELECT f.*,p.purpose published_purpose,p.verified_sha256,p.verified_byte_size,
    l.storage_profile_id active_profile_id,l.object_key actual_object_key,s.adapter_type actual_provider,s.namespace_identity actual_namespace
    FROM research_package_files f JOIN file_usable_publications p ON p.file_id=f.result_file_id
    JOIN file_location_publications l ON l.location_id=p.active_location_id JOIN storage_profiles s ON s.id=l.storage_profile_id
    WHERE f.job_id=? AND f.entry_kind='payload' ORDER BY f.logical_file_id`, [jobId]);
  expect(rows).toHaveLength(15); expect(new Set(rows.map(row => row.result_file_id)).size).toBe(15);
  const defaults = await peer.rows("SELECT role,storage_profile_id FROM storage_role_defaults ORDER BY role"); expect(defaults).toHaveLength(2);
  for (const source of pkg.files) {
    const actual = rows.find(row => row.logical_file_id === source.packageFileId); ensure(actual);
    const role = source.purpose === "research_source" || source.purpose === "provenance" ? "originals" : "internal";
    const selected = defaults.find(row => row.role === role); ensure(selected);
    expect(actual).toMatchObject({ purpose: source.purpose, published_purpose: source.purpose, sha256: source.sha256, byte_size: source.byteSize,
      verified_sha256: source.sha256, verified_byte_size: source.byteSize, target_profile_id: selected.storage_profile_id,
      active_profile_id: selected.storage_profile_id, actual_provider: peer.provider });
    expect(actual.result_file_id).not.toBe(source.packageFileId);
    const payload = expected.get(source.packageFileId); ensure(payload); expect(hash(payload)).toBe(source.sha256); expect(payload.byteLength).toBe(source.byteSize);
    const alias = pkg.records.find(record => record.kind === "fileAlias" && record.data.packageFileId === source.packageFileId);
    if (alias) expect((await peer.rows("SELECT file_id,original_name,mime_type,created_at FROM assets WHERE id=?", [actual.candidate_asset_id as Binding]))[0])
      .toEqual({ file_id: actual.result_file_id, original_name: alias.data.original_name, mime_type: alias.data.mime_type, created_at: alias.data.created_at });
    if (pair) {
      expect(peer.provider).toBe("r2"); ensure(typeof actual.actual_object_key === "string");
      const native = await pair.readObject(actual.actual_object_key);
      expect(native.byteSize).toBe(source.byteSize); expect(new Uint8Array(native.bytes)).toEqual(payload);
      expect(hash(new Uint8Array(native.bytes))).toBe(source.sha256);
    }
  }
  await released(peer); return rows;
}

/** An exported archive must represent the actual source graph, not merely be
 * internally consistent with the graph that a receiver subsequently imports. */
async function assertNativeExportGraph(peer: PackagePeer, importedId: string, original: ResearchPackageV1,
  exported: ResearchPackageV1, captures: Record<string, unknown>[], sourceFiles: Record<string, unknown>[]) {
  const identities = await peer.rows("SELECT entity_kind,source_id,destination_id FROM research_package_identity_maps WHERE job_id=?", [importedId]);
  const mapped = (kind: ImportIdentityKind, sourceId: string) => {
    const identity = identities.find(row => row.entity_kind === kind && row.source_id === sourceId); ensure(identity);
    return String(identity.destination_id);
  };
  const expectedKeys: string[] = [];
  const slots: Array<[ResearchRecordKind, string, string, string | null]> = [
    ['stateAsset','packageFileId','file_id','asset_id'],['executionImage','packageFileId','file_id','asset_id'],
    ['metrologyReference','packageFileId','file_id','asset_id'],['commentOccurrence','packageFileId','file_id','asset_id'],
    ['stateVerification','evidencePackageFileId','evidence_file_id','evidence_asset_id'],['commentItem','packageFileId','file_id','asset_id'],
    ['projectAttachment','packageFileId','file_id','asset_id'],['recipeRevision','sourcePackageFileId','source_file_id',null],
    ['sourceImport','workbookPackageFileId','workbook_file_id',null],['sourceImport','manifestPackageFileId','manifest_file_id',null],
    ['event','packageFileId','asset_file_id','metadata.assetId'],['event','thumbnailPackageFileId','thumbnail_file_id','metadata.thumbnailAssetId'],
  ];
  for (const source of original.records) {
    const definition = RESEARCH_PACKAGE_CATALOG[source.kind];
    if (source.kind === 'fileDerivation' || source.kind === 'attachmentDerivative') {
      const identity = mapped(source.kind, source.sourceId), observed = exported.records.find(row => row.kind === source.kind && row.sourceId === identity); ensure(observed);
      expectedKeys.push(JSON.stringify([source.kind,identity])); expect(observed.data.trust_state).toBe('imported_unverified');
      for (const [field,value] of Object.entries(source.data)) {
        if (field.endsWith('PackageFileId')) {
          if (value === null) { expect(observed.data[field]).toBeNull(); continue; }
          const file = sourceFiles.find(row => row.logical_file_id === value); ensure(file);
          const capture = captures.find(row => row.source_file_id === file.result_file_id); ensure(capture);
          expect(observed.data[field]).toBe(capture.logical_file_id);
        } else if (field === 'derived_asset_id' && value !== null) expect(observed.data[field]).toBe('asset:' + mapped('fileAlias',String(value)));
        else expect(observed.data[field]).toEqual(value);
      }
      continue;
    }
    const bindings = definition.id.map(field => {
      if (field === 'id' || field === 'hash') return mapped(source.kind, source.sourceId);
      const relation = definition.relations?.find(value => value.field === field);
      return relation ? mapped(relation.kind,String(source.data[field])) : source.data[field] as Binding;
    });
    const actual = (await peer.rows(`SELECT * FROM ${definition.table} WHERE ${definition.id.map(field => `${field}=?`).join(' AND ')}`, bindings))[0]; ensure(actual);
    const parts = definition.id.map(field => field === 'asset_id' ? 'asset:' + String(actual[field]) : actual[field]);
    const wireId = source.kind === 'fileAlias' ? 'asset:' + String(actual.id) : parts.length === 1 ? String(parts[0]) : JSON.stringify(parts);
    const observed = exported.records.find(row => row.kind === source.kind && row.sourceId === wireId); ensure(observed);
    expectedKeys.push(JSON.stringify([source.kind,wireId]));
    for (const [field,value] of Object.entries(observed.data)) {
      if (field === 'packageFileId' || field.endsWith('PackageFileId') || ['alias_kind','metadata','relationships','target','contexts','resolution','excluded_targets'].includes(field)
        || source.kind === 'recipeRevision' && field === 'content_json' || !Object.hasOwn(actual,field)) continue;
      const expected = ['asset_id','evidence_asset_id','derived_asset_id'].includes(field) ? actual[field] === null ? null : 'asset:' + String(actual[field])
        : field === 'storage_object_id' ? actual[field] === null ? null : 'managed:' + String(actual[field])
          : definition.fields[field].type === 'json' && actual[field] !== null ? JSON.parse(String(actual[field])) : actual[field];
      expect(value,`${source.kind}:${wireId}.${field}`).toEqual(expected);
    }
    if (source.kind === 'fileAlias') {
      const capture = captures.find(row => row.source_alias_id === wireId); ensure(capture);
      expect(observed.data.packageFileId).toBe(capture.logical_file_id); expect(observed.data.alias_kind).toBe('asset');
    }
    for (const [kind,field,column,aliasColumn] of slots.filter(row => row[0] === source.kind)) {
      if (actual[column] === null) { expect(observed.data[field],`${kind}.${field}`).toBeNull(); continue; }
      const alias = aliasColumn?.startsWith('metadata.') ? JSON.parse(String(actual.metadata_json))[aliasColumn.slice(9)]
        : aliasColumn ? actual[aliasColumn] : null;
      const aliasId = alias === null ? null : 'asset:' + String(alias);
      const capture = captures.find(row => row.source_file_id === actual[column] && row.source_alias_id === aliasId); ensure(capture);
      expect(observed.data[field],`${kind}:${wireId}.${field}`).toBe(capture.logical_file_id);
    }
    if (source.kind === 'reference') {
      const kind = REFERENCE_IMPORT_KINDS[actual.target_type as keyof typeof REFERENCE_IMPORT_KINDS]; ensure(kind);
      expect(observed.data.target).toEqual({kind,sourceId:actual.target_id});
    }
    if (source.kind === 'event') {
      const metadata = JSON.parse(String(actual.metadata_json)) as Record<string, unknown>;
      const expectedRelationships: Array<{field:string;target:{kind:ImportIdentityKind;sourceId:string}}> = [];
      for (const [field,rule] of Object.entries(RESEARCH_EVENT_RELATIONSHIP_FIELDS)) {
        const value = metadata[field];
        if (rule.array) {
          if (Array.isArray(value)) value.forEach((entry,index) => {
            if (typeof entry === 'string') expectedRelationships.push({field:`${field}[${index}]`,target:{kind:rule.kind,sourceId:entry}});
          });
        } else if (typeof value === 'string') expectedRelationships.push({field,target:{kind:rule.kind,sourceId:rule.kind === 'fileAlias' ? 'asset:' + value : value}});
      }
      const observedRelationships = (observed.data.relationships as Array<{field:string;target:{kind:ImportIdentityKind;sourceId:string}}>)
        .map(relation => ({field:relation.field,target:relation.target}));
      expect(observedRelationships.sort((a,b) => a.field.localeCompare(b.field)))
        .toEqual(expectedRelationships.sort((a,b) => a.field.localeCompare(b.field)));
      const typed = new Set(Object.keys(RESEARCH_EVENT_RELATIONSHIP_FIELDS));
      const privateLocators = new Set(['thumbnailKey','assetKey','r2_key','object_key','objectKey','fileId','storageProfileId',
        'storageProfileRevision','provider','storeKind','sourceLocator']);
      const ordinary = Object.fromEntries(Object.entries(metadata).filter(([field]) => !typed.has(field) && !privateLocators.has(field)));
      expect(observed.data.metadata).toEqual(ordinary);
    }
  }
  // Equality of record identities catches omissions/duplication even when the
  // exported graph would otherwise remain self-consistent and importable.
  expect(exported.records.map(row => JSON.stringify([row.kind,row.sourceId])).sort()).toEqual(expectedKeys.sort());
  const ordered = exported.records.filter(row => row.kind === 'stateAsset').sort((a,b) => Number(a.data.position)-Number(b.data.position));
  expect(ordered.map(row => row.data.position)).toEqual([0,1]);
  expect(ordered[0].data.asset_id).not.toBe(ordered[1].data.asset_id);
  expect(ordered[0].data.packageFileId).not.toBe(ordered[1].data.packageFileId);
}

export async function exportPackage(peer: PackagePeer, imported: ResearchJobStatus, pkg: ResearchPackageV1, expected: Map<string, Uint8Array>) {
  ensure(imported.result);
  const sourceFiles = await importedPackageFiles(peer, imported.id, pkg, expected);
  const input = { requestId: randomUUID(), kind: "data_package", roots: imported.result.roots };
  const answer = await peer.request("POST", `${prefix}/jobs`, input); expect(answer.status).toBe(202);
  const receipt = checkedResearchRequestReceipt(answer.value); expect(receipt.job.state).toBe("queued");
  const job = await drainPackage(peer, receipt.job.id, "completed"); ensure(job.output?.available);
  const downloaded = await peer.request("GET", `${prefix}/jobs/${job.id}/download`); expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("content-type")?.split(";", 1)[0]).toBe("application/zip"); ensure(downloaded.value instanceof Uint8Array);
  const bytes = downloaded.value; expect(bytes.byteLength).toBe(job.output.byteSize); expect(hash(bytes)).toBe(job.output.sha256);
  const checked = await validateStoreArchive(sourceFromBlob(new Blob([bytes.slice().buffer as ArrayBuffer])), { expectedSha256: job.output.sha256 });
  const nativePackage = await validateResearchPackage(JSON.parse(new TextDecoder().decode(checked.metadata.get("manifest.json")!)),
    JSON.parse(new TextDecoder().decode(checked.metadata.get("records.json")!))); serializedSlots(nativePackage);
  const sourceIdentity = (await peer.rows("SELECT installation_id FROM research_package_source_identity"))[0]; ensure(sourceIdentity);
  expect(nativePackage.sourceInstallationId).toBe(sourceIdentity.installation_id); expect(nativePackage.sourceInstallationId).not.toBe(pkg.sourceInstallationId);
  expect(nativePackage.packageId).not.toBe(pkg.packageId); expect(nativePackage.files).toHaveLength(15);
  const captures = await peer.rows("SELECT logical_file_id,archive_path,source_file_id,source_alias_id FROM research_package_files WHERE job_id=? AND entry_kind='source' ORDER BY archive_path", [job.id]);
  expect(captures).toHaveLength(15);
  expect(new Set(captures.map(row => row.source_file_id)).size).toBe(15);
  expect(captures.map(row => row.source_file_id).sort()).toEqual(sourceFiles.map(row => row.result_file_id).sort());
  expect(captures.map(row => row.source_alias_id).sort()).toEqual(sourceFiles.map(row => {
    const alias = pkg.records.find(record => record.kind === 'fileAlias' && record.data.packageFileId === row.logical_file_id);
    return alias ? 'asset:' + String(row.candidate_asset_id) : null;
  }).sort());
  await assertNativeExportGraph(peer, imported.id, pkg, nativePackage, captures, sourceFiles);
  expect(checked.entries.map(entry => entry.path).sort()).toEqual(["manifest.json", "records.json", "report/index.html", "report/report.md", ...nativePackage.files.map(file => file.path)].sort());
  const payloads = new Map<string, Uint8Array>();
  for (const capture of captures) {
    const source = sourceFiles.find(file => file.result_file_id === capture.source_file_id); ensure(source);
    const declaration = nativePackage.files.find(file => file.packageFileId === capture.logical_file_id); ensure(declaration);
    const entry = checked.entries.find(value => value.path === capture.archive_path); ensure(entry);
    expect(declaration).toMatchObject({ path: capture.archive_path, purpose: source.purpose, sha256: source.sha256, byteSize: source.byte_size });
    expect(entry).toMatchObject({ path: declaration.path, sha256: declaration.sha256, byteSize: declaration.byteSize });
    const payload = bytes.slice(entry.dataOffset, entry.dataOffset + entry.byteSize), original = expected.get(String(source.logical_file_id)); ensure(original);
    expect(payload).toEqual(original); expect(payload.byteLength).toBe(declaration.byteSize); expect(hash(payload)).toBe(declaration.sha256);
    payloads.set(declaration.packageFileId, payload);
  }
  expect(payloads.size).toBe(15); await released(peer);
  return { bytes, package: nativePackage, payloads, job, input, captures, sourceFiles, sourceIdentity, sha256: job.output.sha256 };
}
