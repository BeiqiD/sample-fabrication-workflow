import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { Log, LogLevel, Miniflare } from "miniflare";
import { expect, it } from "vitest";

/** Isolated native D1 qualifies the trusted deferred-FK publication boundary.
 * Source package parsing/hashes and current jobs/File fences have independent
 * fixtures; no archive SQL or production provider is executed here. */
it("commits valid cyclic identities, rolls back a late missing FK, and restores immediate FK enforcement in native D1", async () => {
  const bundle = await build({ stdin: { loader: "ts", resolveDir: fileURLToPath(new URL(".", import.meta.url)), contents: `
    import { prepareImportDomainPublication } from './import-domain';
    export default { async fetch(request,env) {
      const input=await request.json();
      const db={prepare:sql=>env.DB.prepare(sql),batch:statements=>env.DB.batch(statements),primary(){return this;}};
      const plan={schema:'research-domain-import/1',packageId:'native-package',acceptedAt:'2026-10-06T09:00:00.000Z',
        identities:[],naming:[],namingPreview:{suffix:'',conflicts:[]},roots:[],canonicalFences:[],fileReuses:[],files:[],publicationStatements:2,
        rows:[{kind:'sample',sourceId:'foreign-a',table:'samples',id:input.prefix+'-a',data:{id:input.prefix+'-a',parent_id:input.prefix+'-b'}},
          {kind:'sample',sourceId:'foreign-b',table:'samples',id:input.prefix+'-b',data:{id:input.prefix+'-b',parent_id:input.invalid?'absent-parent':input.prefix+'-a'}}]};
      let committed=true;try{await db.batch(prepareImportDomainPublication(db,plan));}catch{committed=false;}
      const count=await env.DB.prepare('SELECT count(*) n FROM samples WHERE id LIKE ?').bind(input.prefix+'-%').first();
      let immediateRejected=false;try{await env.DB.prepare('INSERT INTO samples(id,parent_id) VALUES(?,?)').bind(input.prefix+'-immediate','absent-parent').run();}
      catch{immediateRejected=true;}
      return Response.json({committed,count:count.n,immediateRejected,deferral:await env.DB.prepare('PRAGMA defer_foreign_keys').first()});
    }};` }, bundle: true, format: "esm", platform: "browser", write: false });
  const native = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-07-20",
    d1Databases: ["DB"], log: new Log(LogLevel.ERROR), outboundService: async () => { throw new Error("Provider access is forbidden"); } });
  try {
    const db = await native.getD1Database("DB");
    await db.prepare("CREATE TABLE samples(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES samples(id))").run();
    const invoke = async (prefix: string, invalid: boolean) => (await native.dispatchFetch("https://native.test", { method: "POST", body: JSON.stringify({ prefix, invalid }) })).json();
    expect(await invoke("valid-cycle", false)).toEqual({ committed: true, count: 2, immediateRejected: true, deferral: { defer_foreign_keys: 0 } });
    expect(await invoke("failed-cycle", true)).toEqual({ committed: false, count: 0, immediateRejected: true, deferral: { defer_foreign_keys: 0 } });
    expect((await db.prepare("SELECT id,parent_id FROM samples ORDER BY id").all()).results).toEqual([
      { id: "valid-cycle-a", parent_id: "valid-cycle-b" }, { id: "valid-cycle-b", parent_id: "valid-cycle-a" },
    ]);
  } finally { await native.dispose(); }
}, 30_000);
