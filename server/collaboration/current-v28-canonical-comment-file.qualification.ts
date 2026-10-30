import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCanonicalFileOwnersReleased, composeCanonicalCommentFileV28,
  consumeCanonicalFileClient, currentCanonicalFileTarget, prepareCanonicalCommentFileBaseline,
  retainedCanonicalFileCase, withCanonicalFileDatabase } from "./current-v28-canonical-comment-file.qualification-support";

// ONE original positive mounted phase. Private first/later chunk revocation and
// autonomous terminal controls are a distinct owner/phase, never duplicated or
// inferred from this finite whole-file delivery scenario.
describe("current V28 original canonical Comment and Local attachment transports",()=>{
  it("uses genuine V26 HTTP and typed stopped File setup, explicit Sample allocation, and original Request all-target purpose for six acceptance and two attachment routes",()=>retainedCanonicalFileCase(async()=>{
    const baseline=await prepareCanonicalCommentFileBaseline();
    await withCanonicalFileDatabase(baseline.path,async(owner,lease,native,core)=>{
      const f=await composeCanonicalCommentFileV28(owner,lease,native,core,baseline);
      const alice=await f.login("alice"),bob=await f.login("bob"),operator=await f.login("operator");
      const targets=()=>baseline.targets.map(target=>currentCanonicalFileTarget(native,target));
      const textId=randomUUID(),textBody="Canonical text shared with a private actual second Sample";
      const textInput={protocol:"comment-submission/1",id:textId,body:textBody,items:[],context:{kind:"run_steps",scope:"common",targets:targets()}};
      expect((await f.request("/api/comment-submissions","POST",textInput,operator)).status).toBe(403);
      expect((await f.request("/api/comment-submissions","POST",textInput,bob)).status).toBe(403);
      expect(native.prepare("SELECT count(*) n FROM comment_submissions WHERE id=?").get(textId)?.n).toBe(0);
      const created=await f.request("/api/comment-submissions","POST",textInput,alice);
      expect(created.status).toBe(201);expect(created.headers.get("cache-control")).toBe("no-store");
      expect(created.value).toMatchObject({id:textId,request:{status:"pending",items:[]}});
      const accepted=await f.request(`/api/comment-submissions/${textId}/acceptance`,"GET",undefined,alice);
      expect(accepted.status).toBe(200);expect(accepted.value).toMatchObject({request:{submissionId:textId,status:"pending"}});
      const finalized=await f.request(`/api/comment-submissions/${textId}/finalize`,"POST",undefined,alice);
      expect(finalized.status).toBe(200);expect(finalized.value).toMatchObject({ok:true,status:"ready",request:{status:"ready"}});
      expect(native.prepare("SELECT count(*) n FROM run_step_comments WHERE submission_id=?").get(textId)?.n).toBe(2);
      expect(native.prepare("SELECT count(*) n FROM events WHERE kind='comment' AND json_extract(metadata_json,'$.submissionId')=?").get(textId)?.n).toBe(2);
      expect((await f.request(`/api/comment-submissions/${textId}/acceptance`,"GET",undefined,alice)).value).toMatchObject({request:{status:"ready"}});

      const bytes=new TextEncoder().encode("Original Local canonical attachment bytes with exact current purpose.");
      const sha256=createHash("sha256").update(bytes).digest("hex"),submissionId=randomUUID(),itemId=randomUUID();
      const filename="canonical Ω.txt",mimeType="text/plain";
      const input={protocol:"comment-submission/1",id:submissionId,body:"Canonical published attachment",context:{kind:"run_steps",scope:"common",targets:targets()},
        items:[{id:itemId,kind:"attachment",filename,mimeType,byteSize:bytes.byteLength,sha256,title:"Current source attachment"}]};
      const attachment=await f.request("/api/comment-submissions","POST",input,alice);
      expect(attachment.status).toBe(201);expect(attachment.value).toMatchObject({request:{status:"pending",items:[{id:itemId,status:"pending"}]}});
      const upload=await f.raw(`/api/comment-submissions/${submissionId}/items/${itemId}/content`,"PUT",alice,bytes,
        {"content-type":mimeType,"x-upload-size":String(bytes.byteLength),"x-content-sha256":sha256});
      const uploadText=await consumeCanonicalFileClient(upload.client,"text") as string;
      expect(upload.response.status).toBe(200);expect(JSON.parse(uploadText) as unknown).toMatchObject({ok:true,request:{items:[{id:itemId,status:"ready"}]}});
      const completed=await f.request(`/api/comment-submissions/${submissionId}/finalize`,"POST",undefined,alice);
      expect(completed.status).toBe(200);expect(completed.value).toMatchObject({ok:true,status:"ready"});
      const published=native.prepare("SELECT file_id FROM comment_submission_items WHERE id=? AND submission_id=? AND status='ready'").get(itemId,submissionId);
      if(typeof published?.file_id!=="string") throw new Error("Actual typed published attachment File is required");
      expect(native.prepare("SELECT count(*) n FROM files WHERE id=?").get(published.file_id)?.n).toBe(1);
      const download=`/api/attachments/${itemId}/download`,exportPath=`/api/exports/attachments/${itemId}`;
      const expectedDisposition=`attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g,"_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      for(const path of [download,exportPath]){
        const read=await f.raw(path,"GET",alice),body=await consumeCanonicalFileClient(read.client,"arrayBuffer") as ArrayBuffer;
        expect(read.response.status).toBe(200);expect(new Uint8Array(body)).toEqual(bytes);
        expect(read.response.headers.get("content-type")).toBe(mimeType);
        expect(read.response.headers.get("content-disposition")).toBe(expectedDisposition);
        expect(read.response.headers.get("cache-control")).toBe("private, no-store");
        expect(read.response.headers.get("x-content-type-options")).toBe("nosniff");
      }
      const deniedOperator=await f.raw(download,"GET",operator);
      const deniedOperatorBody=await consumeCanonicalFileClient(deniedOperator.client,"text") as string;
      expect(deniedOperator.response.status).toBe(403);expect(deniedOperatorBody).not.toContain("Original Local canonical attachment bytes");
      const aTarget=baseline.targets[0]!,bTarget=baseline.targets[1]!;
      const grantA=`/api/collaboration/resources/sample/${aTarget.sampleId}/grants/${baseline.bob.memberId}`;
      const grantB=`/api/collaboration/resources/sample/${bTarget.sampleId}/grants/${baseline.bob.memberId}`;
      expect((await f.request(grantA,"PUT",{operation:"grant",expectedResourceRevision:1,expectedGrantRevision:null,capability:"read",enabled:true},alice)).status).toBe(200);
      const privateRead=await f.raw(download,"GET",bob);
      const privateBody=await consumeCanonicalFileClient(privateRead.client,"text") as string;
      expect(privateRead.response.status).toBe(403);expect(privateBody).not.toContain("Original Local canonical attachment bytes");
      expect((await f.request(grantB,"PUT",{operation:"grant",expectedResourceRevision:1,expectedGrantRevision:null,capability:"read",enabled:true},alice)).status).toBe(200);
      const allowed=await f.raw(download,"GET",bob),allowedBytes=await consumeCanonicalFileClient(allowed.client,"arrayBuffer") as ArrayBuffer;
      expect(allowed.response.status).toBe(200);expect(new Uint8Array(allowedBytes)).toEqual(bytes);
      // Genuine read of both actual roots still grants no acceptance operate/edit
      // or other File purpose/consumer. The original owner check remains exact.
      const readOnlyInput={...textInput,id:randomUUID(),context:{...textInput.context,targets:targets()}};
      expect((await f.request("/api/comment-submissions","POST",readOnlyInput,bob)).status).toBe(403);
      expect((await f.request(grantB,"PUT",{operation:"grant",expectedResourceRevision:2,expectedGrantRevision:1,capability:"read",enabled:false},alice)).status).toBe(200);
      const revoked=await f.raw(exportPath,"GET",bob);
      const revokedText=await consumeCanonicalFileClient(revoked.client,"text") as string;
      expect(revoked.response.status).toBe(403);expect(revokedText).not.toContain("Original Local canonical attachment bytes");

      const cancelledId=randomUUID(),cancelledItemId=randomUUID();
      const pendingInput={...input,id:cancelledId,context:{...input.context,targets:targets()},items:[{...input.items[0]!,id:cancelledItemId}]};
      expect((await f.request("/api/comment-submissions","POST",pendingInput,alice)).status).toBe(201);
      const removed=await f.request(`/api/comment-submissions/${cancelledId}/items/${cancelledItemId}`,"DELETE",undefined,alice);
      expect(removed.status).toBe(200);expect(removed.value).toMatchObject({ok:true,request:{items:[{id:cancelledItemId,status:"cancelled"}]}});
      const cancelled=await f.request(`/api/comment-submissions/${cancelledId}/cancel`,"POST",undefined,alice);
      expect(cancelled.status).toBe(200);expect(cancelled.value).toMatchObject({ok:true,request:{status:"cancelled"}});
      expect((await f.request(`/api/comment-submissions/${cancelledId}/acceptance`,"GET",undefined,alice)).value).toMatchObject({request:{status:"cancelled"}});
      expect(native.prepare("SELECT count(*) n FROM local_admin_grants WHERE principal_id IN(?,?)").get(baseline.alice.principalId,baseline.bob.principalId)?.n).toBe(0);
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // This phase does not claim Sample image-media availability or the old
      // legacy-fenced business mutation families while File authority is active.
      if (!("capabilities" in f.application) || !("routes" in f.application)) throw new Error("Original V28 application capability and route descriptors are required");
      expect(f.application.capabilities.unavailable).toContain("canonical-comment-image-bytes-and-sample-media-descriptors");
      expect(f.application.routes).toEqual(expect.arrayContaining([
        {method:"POST",path:"/api/comment-submissions"},{method:"GET",path:"/api/comment-submissions/:submissionId/acceptance"},
        {method:"PUT",path:"/api/comment-submissions/:submissionId/items/:itemId/content"},{method:"DELETE",path:"/api/comment-submissions/:submissionId/items/:itemId"},
        {method:"POST",path:"/api/comment-submissions/:submissionId/finalize"},{method:"POST",path:"/api/comment-submissions/:submissionId/cancel"},
        {method:"GET",path:"/api/attachments/:itemId/download"},{method:"GET",path:"/api/exports/attachments/:itemId"},
      ]));
    });
    assertCanonicalFileOwnersReleased();
  }),20_000);
});
