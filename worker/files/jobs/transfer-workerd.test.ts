import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare, Response as NativeResponse } from "miniflare";
import { expect, it } from "vitest";
import { FILE_JOB_MAX_BYTES } from "../../../shared/contracts/file-jobs";

it("streams the maximum supported R2→S3 File with native hashing/FixedLengthStream and rejects corrupted readback", async () => {
  const length = FILE_JOB_MAX_BYTES, chunk = new Uint8Array(64 * 1024).fill(61);
  const hash = createHash("sha256"); for (let at = 0; at < length; at += chunk.length) hash.update(chunk);
  const sha256 = hash.digest("hex"), objects = new Map<string, ArrayBuffer>();
  let corrupt = false, maxProviderChunk = 0, writes = 0;
  const bundle = await build({ stdin: { contents: `
    import { cloudflareSha256 } from '../storage-adapters/cloudflare-sha256';
    import { r2ByteReader } from '../storage-adapters/r2-reader';
    import { s3ByteAdapter } from '../../storage/s3-byte-adapter';
    import { writeVerifiedBytes } from '../byte-writer';
    export default {async fetch(request,env) {
      const input=await request.json();let maxHashChunk=0,hashWrites=0;
      const createHash=()=>{const hash=cloudflareSha256();return {write(bytes){maxHashChunk=Math.max(maxHashChunk,bytes.length);hashWrites++;return hash.write(bytes);},finish:()=>hash.finish(),abort:()=>hash.abort()};};
      if(input.seed){
        const fixed=new FixedLengthStream(input.length),writer=fixed.writable.getWriter();
        const fill=(async()=>{try{for(let at=0;at<input.length;at+=65536)await writer.write(new Uint8Array(Math.min(65536,input.length-at)).fill(61));await writer.close();}catch(error){await writer.abort(error);throw error;}})();
        await Promise.all([env.ASSETS.put('source',fixed.readable),fill]);
        return Response.json({seeded:true});
      }
      const read=await r2ByteReader(env.ASSETS).read('source');if(read.outcome!=='available')throw new Error('Source unavailable');
      const adapter=s3ByteAdapter({kind:'s3',endpoint:'https://s3.us-east-1.amazonaws.com',region:'us-east-1',bucket:'native-transfer-spike',root:'',forcePathStyle:true,expectedBucketOwner:'111122223333'},
        {accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'},{fetch:r=>env.PROVIDER.fetch(r)});
      try {const verified=await writeVerifiedBytes({...adapter,createHash},{key:input.key,body:read.body,byteSize:input.length,sha256:input.sha256,filename:'transfer.bin',contentType:'application/octet-stream'});
        return Response.json({outcome:'verified',maxHashChunk,hashWrites,verified});}
      catch(error){return Response.json({outcome:'rejected',maxHashChunk,hashWrites,code:error.code??null});}
    }};`, loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)) },
    bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    r2Buckets: ["ASSETS"], log: new Log(LogLevel.ERROR), serviceBindings: { PROVIDER: async request => {
      expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
      expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
      if (request.method === "PUT") {
        writes++; const bytes: Uint8Array[] = [], reader = request.body!.getReader(); let total = 0;
        while (true) { const read = await reader.read(); if (read.done) break; bytes.push(read.value); total += read.value.length; maxProviderChunk = Math.max(maxProviderChunk, read.value.length); }
        const complete = new Uint8Array(total); let at = 0; for (const part of bytes) { complete.set(part, at); at += part.length; }
        objects.set(request.url, complete.buffer); return new NativeResponse(null);
      }
      const value = objects.get(request.url); if (!value) return new NativeResponse(null, { status: 404 });
      const bytes = new Uint8Array(value.slice(0)); if (corrupt) bytes[bytes.length - 1] ^= 1;
      return new NativeResponse(request.method === "HEAD" ? null : bytes, { headers: { "content-length": String(bytes.byteLength) } });
    } } });
  try {
    const call = async (input: unknown) => (await native.dispatchFetch("https://spike.test", { method: "POST", body: JSON.stringify(input) })).json() as Promise<Record<string, unknown>>;
    expect(await call({ seed: true, length })).toEqual({ seeded: true });
    const passed = await call({ key: "candidate:one", length, sha256 });
    expect(passed.outcome).toBe("verified"); expect(Number(passed.maxHashChunk)).toBeLessThanOrEqual(64 * 1024);
    expect(Number(passed.hashWrites)).toBeGreaterThanOrEqual(2 * Math.ceil(length / chunk.length)); expect(writes).toBe(1);
    expect(createHash("sha256").update(new Uint8Array([...objects.values()][0])).digest("hex")).toBe(sha256);
    corrupt = true;
    const rejected = await call({ key: "candidate:two", length, sha256 });
    expect(rejected.outcome).toBe("rejected"); expect(Number(rejected.maxHashChunk)).toBeLessThanOrEqual(64 * 1024); expect(writes).toBe(2);
    expect(maxProviderChunk).toBeGreaterThan(0);
  } finally { await native.dispose(); }
}, 60_000);
