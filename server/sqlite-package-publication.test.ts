import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { asAdmittedJobSqlDatabase, createSqliteBatchAdmission, createSqliteCapability,
  type SqliteCapability } from "./sqlite";

const owners:Array<{root:string;native:DatabaseSync;core:SqliteCapability}>=[];
afterEach(async()=>{
  for(const owner of owners.splice(0).reverse()) {
    owner.core.close();expect(owner.native.isOpen).toBe(false);
    await rm(owner.root,{recursive:true,force:true});
  }
});
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"node-package-fixed-fk-"));
  const native=new DatabaseSync(join(root,"application.sqlite"),{allowExtension:false});
  const core=createSqliteCapability(native);owners.push({root,native,core});
  await core.batch([
    core.prepare("CREATE TABLE audit(id INTEGER PRIMARY KEY)"),
    core.prepare("CREATE TABLE left_node(id INTEGER PRIMARY KEY,right_id INTEGER NOT NULL REFERENCES right_node(id))"),
    core.prepare("CREATE TABLE right_node(id INTEGER PRIMARY KEY,left_id INTEGER NOT NULL REFERENCES left_node(id))"),
    core.prepare("CREATE TABLE actor_admission(enabled INTEGER NOT NULL CHECK(enabled IN(0,1)))"),
    core.prepare("INSERT INTO actor_admission VALUES(1)"),
  ]);
  const admission=()=>createSqliteBatchAdmission(core,[{statement:core.prepare("SELECT 1 AS admitted FROM actor_admission WHERE enabled=1"),
    rejection:new Error("Current publication actor is revoked")}]);
  const view=asAdmittedJobSqlDatabase(core,admission,{assertHeld(){core.primary();}});
  return {native,core,view,admission};
}
it("publishes a genuine cyclic graph in one admitted batch at the original directive ordinal while plain core PRAGMA stays denied",async()=>{
  const {native,core,view}=await fixture();
  expect(()=>core.prepare("PRAGMA defer_foreign_keys=ON")).toThrow("privileged composer");
  expect(()=>core.prepare("PRAGMA foreign_keys=OFF")).toThrow("privileged composer");
  const callWithExtraArguments=core.prepare as unknown as (...args:unknown[])=>unknown;
  expect(()=>callWithExtraArguments("PRAGMA defer_foreign_keys=ON",[],true)).toThrow("privileged composer");
  await expect(view.prepare("INSERT INTO left_node VALUES(1,1)").run()).rejects.toThrow();
  await view.batch([view.prepare("INSERT INTO audit VALUES(1)"),view.prepare("PRAGMA defer_foreign_keys=ON"),
    view.prepare("INSERT INTO left_node VALUES(1,1)"),view.prepare("INSERT INTO right_node VALUES(1,1)")]);
  expect(native.prepare("SELECT id,right_id FROM left_node").all()).toEqual([{id:1,right_id:1}]);
  expect(native.prepare("SELECT id,left_id FROM right_node").all()).toEqual([{id:1,left_id:1}]);
  expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(native.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
  expect(native.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
});
it("rolls back every original cell on a late missing-FK commit and restores immediate enforcement",async()=>{
  const {native,view}=await fixture();
  await expect(view.batch([view.prepare("INSERT INTO audit VALUES(2)"),view.prepare("PRAGMA defer_foreign_keys=ON"),
    view.prepare("INSERT INTO left_node VALUES(2,99)")])).rejects.toThrow();
  expect(native.prepare("SELECT * FROM audit").all()).toEqual([]);
  expect(native.prepare("SELECT * FROM left_node").all()).toEqual([]);
  expect(native.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
  await expect(view.prepare("INSERT INTO left_node VALUES(3,99)").run()).rejects.toThrow();
});
it("rejects a revoked actor, another core's receipt, and duplicate fixed directives before any original write",async()=>{
  const first=await fixture(),second=await fixture();
  const commands=[first.view.prepare("INSERT INTO audit VALUES(3)"),first.view.prepare("PRAGMA defer_foreign_keys=ON")];
  await first.core.prepare("UPDATE actor_admission SET enabled=0").run();
  await expect(first.view.batch(commands)).rejects.toThrow("actor is revoked");
  expect(first.native.prepare("SELECT * FROM audit").all()).toEqual([]);
  const foreign=asAdmittedJobSqlDatabase(second.core,first.admission,{assertHeld(){second.core.primary();}});
  expect(()=>foreign.prepare("PRAGMA defer_foreign_keys=ON")).toThrow("admission is unavailable");
  const directive=second.view.prepare("PRAGMA defer_foreign_keys=ON");
  await expect(second.view.batch([second.view.prepare("INSERT INTO audit VALUES(4)"),directive,directive])).rejects.toThrow("one issued directive");
  expect(second.native.prepare("SELECT * FROM audit").all()).toEqual([]);
  expect(second.native.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
});
