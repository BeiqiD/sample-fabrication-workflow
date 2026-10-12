import { HTTPException } from "hono/http-exception";
import { stableJson, STEP_HASH_SCHEME } from "../../shared/content-addressing";
import { deriveFabubloxTemplatePublication } from "../../worker/imports/fabublox-template-publication-core";
import { bulkInsertStatementsWithDatabase } from "../../worker/runtime/bulk-insert";
import { configurationSqlCell, configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import { originalByteVerificationError } from "../../worker/files/byte-verification";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import type { LocalUploadExecution } from "../files/local-upload-execution";
import { runOwnedFileAuthorityBatchWithNativeResults } from "../file-authority-sql";
import { ownedLocalFabubloxAcceptedV28Candidate, type LocalFabubloxAcceptedV28Candidate } from "./local-fabublox-permission-v28-candidate";
import { consumeLocalFabubloxPreparedFilesV28Candidate, prepareLocalFabubloxAuthorityV28Candidate,
  recoverLocalFabubloxAuthorityV28Candidate } from "./local-fabublox-authority-v28-candidate";

export interface LocalFabubloxPublishedV28Candidate {
  readonly id: string; readonly templateVersionId: string; readonly version: number;
}
const publications = new WeakMap<LocalFabubloxAcceptedV28Candidate, Promise<LocalFabubloxPublishedV28Candidate>>();
const unavailable = () => new HTTPException(503, { message: "Current original import finalization is unavailable." });

function retainedCleanup(error:unknown,seen=new Set<unknown>()):StorageProfileCleanupError|undefined {
  if(error instanceof StorageProfileCleanupError)return error;
  if(!error || typeof error!=="object" || seen.has(error))return;
  seen.add(error);
  if(error instanceof AggregateError)for(const child of error.errors){const found=retainedCleanup(child,seen);if(found)return found;}
  if(error instanceof Error)return retainedCleanup(error.cause,seen);
}
function preserveOrderedFailure(work:unknown,final:unknown):unknown {
  const failure=new AggregateError([work,final],"Original import work and final authority failed");
  const cleanup=retainedCleanup(failure);
  return cleanup?new StorageProfileCleanupError(failure,cleanup.cleanupCause,cleanup.ownership):failure;
}
function mappedOriginalError(work:unknown,retained:unknown=work):never {
  // Keep the original typed first-cleanup barrier visible to the enclosing
  // execution. A byte status must not conceal that failed ownership ACK.
  if(retainedCleanup(retained))throw retained;
  const originalWork=originalByteVerificationError(work);
  if(originalWork){
    const badSource=originalWork.phase==="source" && (originalWork.reason==="size_mismatch" || originalWork.reason==="hash_mismatch");
    throw new HTTPException(badSource?400:503,{message:originalWork.message,cause:retained});
  }
  throw retained;
}

/** Whole original active metadata/publication algorithm on the consumed
 * original Request, accepted receipt and still-held execution. The returned
 * promise is reserved before original awaits. It performs one possible PUT
 * preparation and one possible final batch; reentry never redispatches either.
 * This candidate does not mount a route or issue a provider/Template grant. */
export function publishLocalFabubloxTemplateV28Candidate(execution:LocalUploadExecution,request:Request,
  accepted:LocalFabubloxAcceptedV28Candidate):Promise<LocalFabubloxPublishedV28Candidate> {
  const owner=ownedLocalFabubloxAcceptedV28Candidate(accepted,execution,request);
  const previous=publications.get(accepted);if(previous)return previous;
  const original=Promise.resolve().then(async()=>{
    const {payload,input,family}=owner,manifest=payload.manifest;
    const importId=input.importId,importOperationId=input.operationId,userEmail=input.actorEmail;
    const recipeFamilyId=family.id,recipeName=family.name,internalTemplateType=family.templateType,now=input.createdAt;
    const finalizationId=crypto.randomUUID();
    let completedTemplateVersionId:string|null=null,completedVersion:number|null=null;
    let readyResult:LocalFabubloxPublishedV28Candidate|undefined;
    async function assertFinalCurrent():Promise<void>{
      owner.assertCurrent();
      if(typeof execution.assertFabubloxRequestCurrent!=="function" || typeof execution.fabubloxAcceptanceDatabase!=="function")throw unavailable();
      await execution.assertFabubloxRequestCurrent();
      // Fresh final-only purpose guards and every original physical profile
      // pin are issued on this same actual core after the verified phase ACK.
      await execution.fabubloxAcceptanceDatabase(owner.authorities).batch([]);
      owner.assertCurrent();
    }
    async function acceptActualReadyResult():Promise<LocalFabubloxPublishedV28Candidate>{
      if(!readyResult)throw unavailable();
      owner.acknowledgeFinalization();
      await assertFinalCurrent();return readyResult;
    }
    try {
      const token=await prepareLocalFabubloxAuthorityV28Candidate(execution,request,accepted);
      const prepared=consumeLocalFabubloxPreparedFilesV28Candidate(execution,request,accepted,token);
      // All statements (including the supplier's original publication/alias
      // and captured physical fences) belong to this exact Native view. A
      // fresh history view has a foreign private statement registry.
      const database=prepared.database,resolved=prepared.result.assets,authorityStatements=prepared.result.statements;
      const selectedItems=new Set<string>();
      for(const asset of resolved){
        const itemId=asset.kind==='image'?`image:${asset.localId}`:asset.kind;
        const target=input.fileTargets?.find(target=>target.itemId===itemId);
        if(!target || selectedItems.has(itemId) || !asset.assetId || !asset.fileId || !asset.key || asset.legacyKey!==null
          || asset.sha256!==target.sha256 || asset.buffer.byteLength!==target.byteSize)throw unavailable();
        if(asset.kind==='image' && asset.image!==manifest.images.find(image=>image.localId===asset.localId))throw unavailable();
        selectedItems.add(itemId);
      }
      if(resolved.length!==input.fileTargets?.length || !selectedItems.has('workbook') || !selectedItems.has('manifest'))throw unavailable();
      const latest=await database.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM template_versions WHERE recipe_family_id = ?",
      ).bind(recipeFamilyId).first();
      const currentVersion=configurationSqlInteger(latest?.version??0,"FabuBlox latest Template version",0);
      if(currentVersion===Number.MAX_SAFE_INTEGER)throw new TypeError("FabuBlox next Template version is outside its integer domain");
      const version=currentVersion+1;
      const templateVersionId=crypto.randomUUID();
      completedVersion=version;completedTemplateVersionId=templateVersionId;
      const stepIds=new Map(manifest.steps.map(step=>[step.localId,crypto.randomUUID()]));
      const derived=await deriveFabubloxTemplatePublication(manifest,resolved,stepIds);
      const {workbookAsset,manifestAsset,workbookLegacyKey,manifestLegacyKey,definitions,states,stateAssetRows,
        initialStateHash,preparedSteps,manifestHash}=derived;
      const templateContentJson=JSON.stringify({
        schemaVersion:manifest.schemaVersion,source:manifest.source,importedTitle:manifest.title,
        objectKind:"process_template",initialSubstrateStep:manifest.initialSubstrateStep,warningCount:manifest.warnings.length,
      });
      readyResult=Object.freeze({id:importId,templateVersionId,version});
      const acceptedResultJson=JSON.stringify(readyResult),finalizationAssetRows=JSON.stringify([...stateAssetRows.values()]);
      const aliasesJson=JSON.stringify(resolved.map(asset=>({itemId:asset.kind==='image'?`image:${asset.localId}`:asset.kind,
        assetId:asset.assetId,fileId:asset.fileId,objectKey:asset.key})));
      owner.reserveFinalization({finalizationId,templateVersionId,version,resultJson:acceptedResultJson,
        workbookFileId:workbookAsset.fileId,manifestFileId:manifestAsset.fileId,manifestHash,initialStateHash,
        templateContentJson,stateAssetRowsJson:finalizationAssetRows,aliasesJson});

      const existingDefinitionHashes=new Set<string>();
      const definitionHashes=[...definitions.keys()];
      for(let index=0;index<definitionHashes.length;index+=90){
        const chunk=definitionHashes.slice(index,index+90);
        const rows=await database.prepare(`SELECT hash FROM step_definitions WHERE hash IN (${chunk.map(()=>"?").join(", ")})`)
          .bind(...chunk).all();
        rows.results.forEach(row=>{if(typeof row.hash!=="string")throw new TypeError("Invalid existing definition hash");existingDefinitionHashes.add(row.hash);});
      }
      const stateHashes=[...states.keys()],existingStateHashes=new Set<string>();
      if(stateHashes.length){
        const rows=await database.prepare("SELECT hash FROM state_representations WHERE hash IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(stateHashes)).all();
        rows.results.forEach(row=>{if(typeof row.hash!=="string")throw new TypeError("Invalid existing state hash");existingStateHashes.add(row.hash);});
      }
      const bulkDatabase={prepare(sql:string){return {bind(...values:unknown[]){return database.prepare(sql).bind(...values.map(configurationSqlCell));}};}};
      // The genuine early family/resource/manage allocation was already one
      // admitted acceptance batch. Repeating the old late family INSERT would
      // violate that deliberately accepted delta; all remaining original
      // metadata rows/fields, source version and statement ordering remain.
      const metadataStatements=[
        database.prepare(`UPDATE imports SET template_version_id = ?
         WHERE id = ? AND status = 'pending' AND operation_id = ?
           AND finalization_id IS NULL AND lease_expires_at > ?`)
          .bind(templateVersionId,importId,importOperationId,now),
        ...bulkInsertStatementsWithDatabase(bulkDatabase,"step_definitions",
          ["hash","hash_scheme","name","tool_name","parameters_text","comments_text","canonical_json","created_at"],
          [...definitions.values()].filter(definition=>!existingDefinitionHashes.has(definition.hash)).map(definition=>[
            definition.hash,STEP_HASH_SCHEME,definition.canonical.name,definition.canonical.toolName,
            definition.canonical.parametersText,definition.canonical.commentsText,stableJson(definition.canonical),now,
          ])),
        ...bulkInsertStatementsWithDatabase(bulkDatabase,"state_representations",
          ["hash","hash_scheme","representation_type","content_json","created_at"],
          [...states.values()].filter(state=>!existingStateHashes.has(state.hash)).map(state=>[
            state.hash,String(state.canonical.schema),String(state.canonical.type),stableJson(state.canonical),now,
          ])),
        database.prepare(`INSERT INTO template_versions
          (id, recipe_family_id, name, template_type, version, manifest_hash, initial_state_hash,
           source_filename, source_asset_key, content_json, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM imports owning_import
         WHERE owning_import.id = ? AND owning_import.status = 'pending'
           AND owning_import.operation_id = ? AND owning_import.finalization_id IS NULL
           AND owning_import.template_version_id = ? AND owning_import.lease_expires_at > ?`)
          .bind(templateVersionId,recipeFamilyId,recipeName,internalTemplateType,version,manifestHash,initialStateHash,
            payload.workbook.name,workbookLegacyKey,templateContentJson,userEmail,now,importId,importOperationId,templateVersionId,now),
        ...bulkInsertStatementsWithDatabase(bulkDatabase,"template_steps",
          ["id","template_version_id","logical_step_key","position","source_row","step_number","section_name","definition_hash","expected_state_hash","raw_json"],
          preparedSteps.map(step=>[stepIds.get(step.source.localId),templateVersionId,step.logicalKey,step.source.position,
            step.source.sourceRow,step.source.stepNumber,step.source.sectionName,step.definitionHash,step.expectedStateHash,JSON.stringify(step.source.rawCells)])),
      ];
      for(let index=0;index<metadataStatements.length;index+=45)
        await database.batch(metadataStatements.slice(index,index+45));

      const completedAt=new Date().toISOString();
      const finalizationDb=database.primary();
      const beforeFinalization=[
        ...authorityStatements,
        finalizationDb.prepare(`UPDATE imports SET workbook_asset_key=?,manifest_asset_key=?
          WHERE id=? AND status='pending' AND operation_id=?`)
          .bind(workbookLegacyKey,manifestLegacyKey,importId,importOperationId),
        finalizationDb.prepare(`UPDATE template_versions SET source_file_id=? WHERE id=?`)
          .bind(workbookAsset.fileId,templateVersionId),
      ];
      const finalStatements=[
        ...beforeFinalization,
        finalizationDb.prepare(`
        UPDATE imports
        SET status = 'ready', workbook_asset_key = ?, manifest_asset_key = ?,
            finalization_id = ?, completed_at = ?, lease_expires_at = NULL,
            accepted_result_json = ?, workbook_file_id = ?, manifest_file_id = ?
        WHERE id = ? AND status = 'pending' AND operation_id = ?
          AND template_version_id = ? AND lease_expires_at > ?
      `).bind(workbookLegacyKey,manifestLegacyKey,finalizationId,completedAt,acceptedResultJson,
          workbookAsset.fileId,manifestAsset.fileId,importId,importOperationId,templateVersionId,completedAt),
        finalizationDb.prepare(`
        INSERT INTO state_representation_assets (state_hash, asset_id, position, file_id)
        SELECT CAST(json_extract(entry.value, '$[0]') AS TEXT),
               CAST(json_extract(entry.value, '$[1]') AS TEXT),
               CAST(json_extract(entry.value, '$[2]') AS INTEGER), CAST(json_extract(entry.value, '$[3]') AS TEXT)
        FROM json_each(?) entry
        WHERE EXISTS (
          SELECT 1 FROM imports owning_import
          WHERE owning_import.id = ? AND owning_import.status = 'ready'
            AND owning_import.operation_id = ?
            AND owning_import.finalization_id = ?
            AND owning_import.template_version_id = ?
        )
        ON CONFLICT(state_hash, asset_id) DO UPDATE SET
          position = excluded.position
      `).bind(finalizationAssetRows,importId,importOperationId,finalizationId,templateVersionId),
        finalizationDb.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM imports WHERE id=? AND operation_id=? AND finalization_id=?
          AND template_version_id=? AND status='ready' AND workbook_file_id=? AND manifest_file_id=?
      ) THEN 1 ELSE json('Import File publication did not complete') END`)
          .bind(importId,importOperationId,finalizationId,templateVersionId,workbookAsset.fileId,manifestAsset.fileId),
      ];
      // Actual native top-level directChanges and exact ordinal are retained.
      // No SELECT changes(), mutable fake result/meta, split File commit or
      // second Native view can replace this one original same-BEGIN result.
      const finalizationResults=await runOwnedFileAuthorityBatchWithNativeResults(database,finalStatements);
      const finalizationResult=finalizationResults[beforeFinalization.length];
      if(finalizationResults.length!==finalStatements.length || !finalizationResult)throw unavailable();
      if(!finalizationResult.meta.directChanges)throw new HTTPException(409,{message:"The import lease changed before finalization"});
      return await acceptActualReadyResult();
    } catch(error) {
      if(retainedCleanup(error))throw error;
      let authoritative;
      try{authoritative=owner.inspectOriginalFinalization();}
      catch(readError){
        const failure=preserveOrderedFailure(error,readError);
        const cleanup=retainedCleanup(failure);if(cleanup)throw failure;
        throw new HTTPException(503,{message:"Import finalization outcome is unknown; persistent recovery will reconcile it",cause:failure});
      }
      if(authoritative?.status==='ready' && authoritative.operation_id===importOperationId
        && authoritative.finalization_id===finalizationId && authoritative.template_version_id===completedTemplateVersionId
        && completedTemplateVersionId!==null && completedVersion!==null){
        // Reconciliation acknowledges only this actual own committed result.
        // A rejected body/provider first ACK still blocks result and release.
        if(retainedCleanup(error))throw error;
        try{return await acceptActualReadyResult();}
        catch(finalError){throw preserveOrderedFailure(error,finalError);}
      }
      let failure:unknown=error;
      if(authoritative?.status==='pending' && authoritative.operation_id===importOperationId && authoritative.finalization_id===null){
        try{
          // The original controller's error bound is 1000; the lower helper's
          // larger input bound does not replace that original contract.
          const message=(error instanceof Error?error.message:String(error)).slice(0,1000);
          await recoverLocalFabubloxAuthorityV28Candidate(execution,request,accepted,message);
        }catch(recoveryError){failure=preserveOrderedFailure(error,recoveryError);}
      }
      mappedOriginalError(error,failure);
    }
  });
  publications.set(accepted,original);original.then(()=>undefined,()=>undefined);return original;
}
