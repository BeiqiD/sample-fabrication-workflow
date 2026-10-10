import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { expect, it } from "vitest";

it.each([16 * 1024 * 1024, 96 * 1024 * 1024])("streams %i-byte research payloads through native R2 and DigestStream, verifies reopened bytes and rejects terminal corruption", async length => {
  const chunk = new Uint8Array(64 * 1024).fill(61), hash = createHash("sha256");
  for (let at = 0; at < length; at += chunk.length) hash.update(chunk);
  const expectedSha = hash.digest("hex");
  const bundle = await build({ stdin: { contents: `
    import { cloudflareSha256 } from '../../worker/files/storage-adapters/cloudflare-sha256';
    import { hashResearchStream } from './research-sha256';
    import { measureStoreArchive,createStoreArchiveStream,sourceFromStream,validateStoreArchive,openStoreArchiveEntry } from './research-archive';
    const hex=bytes=>[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');
    const encoder=new TextEncoder();
    export default {async fetch(request,env){
      const input=await request.json();let maxHashChunk=0,maxZipChunk=0,maxRawArchiveChunk=0,reopens=0;
      const createHash=()=>{const hash=cloudflareSha256();return {write(bytes){maxHashChunk=Math.max(maxHashChunk,bytes.length);return hash.write(bytes);},finish:()=>hash.finish(),abort:()=>hash.abort()};};
      const fixed=new FixedLengthStream(input.length),writer=fixed.writable.getWriter();
      const fill=(async()=>{try{for(let at=0;at<input.length;at+=65536)await writer.write(new Uint8Array(Math.min(65536,input.length-at)).fill(61));await writer.close();}catch(error){void writer.abort(error);throw error;}})();
      await Promise.all([env.ARCHIVES.put('source',fixed.readable),fill]);
      const portable=await hashResearchStream((await env.ARCHIVES.get('source')).body,{maxBytes:input.length,expectedByteSize:input.length});
      const names=['manifest.json','records.json','report/index.html','report/report.md'];
      const texts=['{"schema":"research-package/1"}','{"schema":"research-records/1","records":[]}','<!doctype html><p>Report</p>','# Report'];
      const metadata=new Map(names.map((path,index)=>[path,encoder.encode(texts[index])]));
      const entries=await Promise.all(names.map(async(path,index)=>{const bytes=metadata.get(path);return {path,kind:index<2?'metadata':'report',byteSize:bytes.length,sha256:hex(await crypto.subtle.digest('SHA-256',bytes))};}));
      entries.push({path:'files/f_source',kind:'payload',byteSize:input.length,sha256:input.sha256});
      const openEntry=async entry=>entry.kind==='payload'?(await env.ARCHIVES.get('source')).body:new Response(metadata.get(entry.path)).body;
      const measured=await measureStoreArchive(entries,openEntry,{createHash});
      const output=createStoreArchiveStream(entries,openEntry,{createHash}).pipeThrough(new TransformStream({transform(bytes,controller){maxZipChunk=Math.max(maxZipChunk,bytes.length);controller.enqueue(bytes);}}));
      const archiveFixed=new FixedLengthStream(measured.byteSize),outputting=output.pipeTo(archiveFixed.writable);
      await Promise.all([env.ARCHIVES.put('package.zip',archiveFixed.readable),outputting]);
      const object=await env.ARCHIVES.head('package.zip');
      const source=sourceFromStream(object.size,async()=>{reopens++;return (await env.ARCHIVES.get('package.zip')).body.pipeThrough(new TransformStream({transform(bytes,controller){maxRawArchiveChunk=Math.max(maxRawArchiveChunk,bytes.length);controller.enqueue(bytes);}}));});
      const checked=await validateStoreArchive(source,{expectedSha256:measured.sha256,expectedEntries:entries,createHash});
      const validationReads=source.bytesRead,validationReopens=reopens,payload=checked.entries.find(entry=>entry.kind==='payload');
      const extracted=await hashResearchStream(await openStoreArchiveEntry(source,payload,{createHash}),{maxBytes:input.length,expectedByteSize:input.length});
      let corruptRejected=false;
      const corrupt=sourceFromStream(object.size,async()=>{
        let at=0;return (await env.ARCHIVES.get('package.zip')).body.pipeThrough(new TransformStream({transform(bytes,controller){const target=payload.descriptorOffset-1;if(target>=at&&target<at+bytes.length){bytes=bytes.slice();bytes[target-at]^=1;}at+=bytes.length;controller.enqueue(bytes);}}));
      });
      try{await validateStoreArchive(corrupt,{expectedSha256:measured.sha256,expectedEntries:entries,createHash});}catch(error){corruptRejected=error.code==='integrity';}finally{corrupt.dispose();source.dispose();}
      let heldPulled=false,heldCancelled=false;
      const held=new ReadableStream({pull(){heldPulled=true;return new Promise(()=>{});},cancel(){heldCancelled=true;return new Promise(()=>{});}},{highWaterMark:0});
      const interrupted=createStoreArchiveStream(entries,async()=>held,{createHash}),interruptedReader=interrupted.getReader();
      await interruptedReader.read();const blocked=interruptedReader.read();
      for(let turn=0;turn<20&&!heldPulled;turn++)await Promise.resolve();
      await interruptedReader.cancel(new Error('Output consumer disconnected'));
      const cancelledRead=await blocked,interruptedReleased=heldPulled&&heldCancelled&&!held.locked&&cancelledRead.done;interruptedReader.releaseLock();
      return Response.json({measured,actualBytes:object.size,portable,extracted,maxHashChunk,maxZipChunk,maxRawArchiveChunk,validationReads,validationReopens,corruptRejected,interruptedReleased});
    }};`, loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)) }, bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20", r2Buckets: ["ARCHIVES"], log: new Log(LogLevel.ERROR) });
  try {
    const response = await native.dispatchFetch("https://archive-spike.test", { method: "POST", body: JSON.stringify({ length, sha256: expectedSha }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as { measured: { byteSize: number; sha256: string }; actualBytes: number;
      portable: { byteSize: number; sha256: string }; extracted: { byteSize: number; sha256: string };
      maxHashChunk: number; maxZipChunk: number; maxRawArchiveChunk: number; validationReads: number; validationReopens: number; corruptRejected: boolean; interruptedReleased: boolean };
    expect(result.portable).toEqual({ byteSize: length, sha256: expectedSha }); expect(result.extracted).toEqual(result.portable);
    expect(result.actualBytes).toBe(result.measured.byteSize); expect(result.measured.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.maxHashChunk).toBeLessThanOrEqual(64 * 1024); expect(result.maxZipChunk).toBeLessThanOrEqual(64 * 1024);
    expect(result.validationReopens).toBe(2); expect(result.validationReads).toBeLessThanOrEqual(2 * result.actualBytes); expect(result.corruptRejected).toBe(true);
    expect(result.interruptedReleased).toBe(true);
    const budgets = { payloadBytes: length, archiveBytes: result.actualBytes,
      validationPhysicalBytes: result.validationReads, maxHashChunk: result.maxHashChunk, maxZipChunk: result.maxZipChunk,
      maxRawArchiveChunk: result.maxRawArchiveChunk, nodeHostMaxRssKiB: process.resourceUsage().maxRSS };
    if (process.env.FP4_ARCHIVE_BUDGET_FILE) writeFileSync(process.env.FP4_ARCHIVE_BUDGET_FILE, JSON.stringify(budgets, null, 2) + "\n");
  } finally { await native.dispose(); }
}, 60_000);
