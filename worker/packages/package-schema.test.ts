import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
import { referenceTestDatabase } from "../reference-test-support";

const migration="0020_fp4_research_packages.sql";
const sql=readFileSync(new URL(`../../migrations/${migration}`,import.meta.url),"utf8");
const opened:ReturnType<typeof referenceTestDatabase>[]=[];
afterEach(()=>opened.splice(0).forEach(db=>db.close()));
const catalog=(db:ReturnType<typeof referenceTestDatabase>)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();

describe("FP4 successor schema qualification",()=>{
  it("individually prepares every Wrangler split statement, preserves old populated cells/rowids, and leaves the ledger last",()=>{
    const whole=referenceTestDatabase({throughMigration:"0019_fp3_file_jobs.sql"});opened.push(whole);
    const split=referenceTestDatabase({throughMigration:"0019_fp3_file_jobs.sql"});opened.push(split);
    for(const db of [whole,split]){
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('fp4-old','FP4-OLD','Preserved before package schema','2026-10-06T12:00:00.000Z','2026-10-06T12:00:00.000Z')").run();
      db.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL)");
    }
    const tables=whole.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'d1_migrations' ORDER BY name").all() as {name:string}[];
    const old=tables.map(({name})=>({name,rows:whole.prepare(`SELECT * FROM "${name}"`).all(),
      rowids:String(whole.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name)!.sql).includes("WITHOUT ROWID")?null:whole.prepare(`SELECT rowid,* FROM "${name}"`).all()}));
    whole.exec(sql);whole.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(migration);
    const statements=splitSql(`${sql}\nINSERT INTO d1_migrations(name) VALUES('${migration}');`);
    expect(statements).toHaveLength(splitSql(sql).length+1);
    expect(statements.at(-1)).toContain("INSERT INTO d1_migrations");
    split.exec("BEGIN");try{for(const statement of statements)split.prepare(statement).run();split.exec("COMMIT");}catch(error){split.exec("ROLLBACK");throw error;}
    expect(catalog(split)).toEqual(catalog(whole));
    for(const prior of old)for(const db of [whole,split]){
      expect(db.prepare(`SELECT * FROM "${prior.name}"`).all()).toEqual(prior.rows);
      if(prior.rowids)expect(db.prepare(`SELECT rowid,* FROM "${prior.name}"`).all()).toEqual(prior.rowids);
    }
    expect(split.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(split.prepare("PRAGMA quick_check").get()).toMatchObject({quick_check:"ok"});
    expect(split.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).toEqual([{name:migration}]);
    expect(split.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='view' AND name LIKE 'research_package_%'").get()).toMatchObject({n:4});
  },30_000);
});
