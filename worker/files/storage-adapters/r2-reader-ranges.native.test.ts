import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { expect, it } from "vitest";
it("uses the actual native R2 offset/length response rather than a full-object fixture", async () => {
  const bundle = await build({ stdin: { contents: `
    import {r2ByteReader} from './r2-reader';
    export default {async fetch(request,env){
      await env.RANGES.put('opaque/%2F/a//b',new Uint8Array(100).map((_,i)=>i));
      const reader=r2ByteReader(env.RANGES), result=await reader.readRange('opaque/%2F/a//b',{offset:7,length:11});
      if(result.outcome!=='available')return Response.json(result,{status:500});
      return Response.json({outcome:result.outcome,byteSize:result.byteSize,range:result.range,bytes:[...new Uint8Array(await new Response(result.body).arrayBuffer())]});
    }};`, loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)) }, bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20", r2Buckets: ["RANGES"], log: new Log(LogLevel.ERROR) });
  try {
    const response = await native.dispatchFetch("https://ranges.test");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ outcome: "available", byteSize: 100, range: { offset: 7, length: 11 }, bytes: Array.from({ length: 11 }, (_, i) => i + 7) });
  } finally { await native.dispose(); }
}, 20000);
