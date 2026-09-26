import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase } from "../reference-test-support";

const NOW = "2026-09-25T00:00:00.000Z";
const SHA = "a".repeat(64);
const databases: DatabaseSync[] = [];
function database() {
  const db = referenceTestDatabase();
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
function enable(db: DatabaseSync) {
  db.prepare("INSERT INTO file_shadow_enablements SELECT 1,epoch,'operator',? FROM file_shadow_control").run(NOW);
}
function stagedCandidate() {
  const db = database();
  db.exec(`
    INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('s','S','Sample','${NOW}','${NOW}');
    INSERT INTO storage_profiles VALUES('profile','r2','r2:fixture:bucket','bootstrap',NULL,1,'historical','${NOW}');
    INSERT INTO events(id,sample_id,kind,asset_key,metadata_json,created_at)
      VALUES('event','s','image','source-key','{"action":"sample_record"}','${NOW}');
    INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
      VALUES('source','embedded_content','system',1,'${SHA}','unresolved','${NOW}'),
      ('candidate','embedded_content','system',1,'${SHA}','unresolved','${NOW}');
    INSERT INTO file_locations VALUES('source','source','profile','source-key','unresolved','${NOW}'),
      ('candidate','candidate','profile','candidate-key','unresolved','${NOW}');
    INSERT INTO legacy_file_mappings VALUES('r2','r2','source-key','source','source','classified','{}','${NOW}');
    INSERT INTO file_shadow_enablements SELECT 1,epoch,'operator','${NOW}' FROM file_shadow_control;
    INSERT INTO file_shadow_profile_enablements VALUES('profile',1,'operator','${NOW}');
    UPDATE file_shadow_runtime_guard SET enabled=1,incarnation='runtime',enabled_by='operator',updated_at='${NOW}';
    INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,
      source_store_kind,source_provider,source_object_key,source_profile_id,source_profile_revision,
      source_expected_byte_size,source_expected_sha256,destination_profile_id,destination_profile_revision,status,created_by,created_at)
      SELECT 'operation',h.occurrence_id,c.epoch,'${SHA}','embedded_content','system','r2','r2','source-key','profile',1,
        1,'${SHA}','profile',1,'pending','operator','${NOW}' FROM file_shadow_heads h CROSS JOIN file_shadow_control c
        WHERE h.consumer_kind='event' AND h.consumer_id='event' AND h.file_slot='primary';
    INSERT INTO file_shadow_legacy_holds VALUES('source-hold','operation','r2','r2','source-key','profile',1,'${NOW}',NULL);
    INSERT INTO file_shadow_attempts(id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
      VALUES('attempt','operation',1,'owner','runtime','staged','2099-01-01T00:00:00.000Z','${NOW}');
    UPDATE file_shadow_attempts SET candidate_file_id='candidate',candidate_location_id='candidate',candidate_object_key='candidate-key',
      verified_byte_size=1,verified_sha256='${SHA}',source_verified_at='${NOW}' WHERE id='attempt';
  `);
  return db;
}
function destinationHold(db: DatabaseSync, expiresAt: string | null = null) {
  db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
    VALUES('destination-hold','candidate','transition_destination','operation','Conversion candidate',?,?)`).run(NOW, expiresAt);
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("File shadow SQL identity and legacy deletion fences", () => {
  it.each([0, 1])("closes identical UPDATE OR REPLACE victims with recursive_triggers=%s", (recursive) => {
    const db = database();
    db.exec(`PRAGMA recursive_triggers=${recursive}`);
    db.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('s','S','Sample',?,?)").run(NOW, NOW);
    enable(db);
    for (const rowid of [-1, 0, 20]) {
      const mover = `mover-${rowid}`, victim = `victim-${rowid}`;
      const insert = db.prepare(`INSERT INTO events(rowid,id,sample_id,kind,asset_key,metadata_json,created_at)
        VALUES(?,?,'s','image','same-key','{"action":"sample_record","thumbnailKey":"same-preview"}',?)`);
      insert.run(rowid + 100, mover, NOW);
      insert.run(rowid, victim, NOW);
      const prior = db.prepare("SELECT * FROM file_shadow_heads WHERE consumer_kind='event' AND consumer_id=? ORDER BY file_slot").all(victim);
      for (const head of prior) {
        const operation = `${victim}-${head.file_slot}`;
        db.prepare(`INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,access_scope,
          source_store_kind,source_provider,source_object_key,status,created_by,created_at)
          SELECT ?,o.id,c.epoch,?,'system',o.legacy_store_kind,o.legacy_provider,o.legacy_object_key,'pending','operator',?
          FROM file_shadow_occurrences o CROSS JOIN file_shadow_control c WHERE o.id=?`).run(operation, SHA, NOW, head.occurrence_id);
        db.prepare(`INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,baseline_sha256,reason,decided_by,decided_at)
          VALUES(?,?,'admitted_unresolved',?,'prior physical owner','operator',?)`).run(head.occurrence_id, operation, SHA, NOW);
        db.prepare("UPDATE file_shadow_operations SET status='admitted_unresolved',completed_at=? WHERE id=?").run(NOW, operation);
      }
      db.prepare("UPDATE OR REPLACE events SET id=?,rowid=? WHERE id=?").run(victim, rowid, mover);
      const current = db.prepare("SELECT * FROM file_shadow_heads WHERE consumer_kind='event' AND consumer_id=? ORDER BY file_slot").all(victim);
      expect(current).toHaveLength(2);
      for (const [index, head] of current.entries()) {
        expect(head.source_json).toBe(prior[index].source_json);
        expect(head.source_rowid).toBe(prior[index].source_rowid);
        expect(head.occurrence_id).not.toBe(prior[index].occurrence_id);
        expect(Number(head.generation)).toBeGreaterThan(Number(prior[index].generation));
        expect(db.prepare("SELECT 1 FROM file_shadow_closures WHERE occurrence_id=?").get(prior[index].occurrence_id)).toBeDefined();
        expect(db.prepare("SELECT 1 FROM file_shadow_decisions WHERE occurrence_id=?").get(head.occurrence_id)).toBeUndefined();
      }
      expect(db.prepare("SELECT present FROM file_shadow_heads WHERE consumer_kind='event' AND consumer_id=?").all(mover))
        .toEqual([{ present: 0 }, { present: 0 }]);
      db.prepare("UPDATE events SET id=id,rowid=rowid WHERE id=?").run(victim);
      expect(db.prepare("SELECT * FROM file_shadow_heads WHERE consumer_kind='event' AND consumer_id=? ORDER BY file_slot").all(victim)).toEqual(current);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it.each(["hold_first", "gc_first"])("fences receipt-only legacy namespaces in %s order", (order) => {
    const db = database();
    for (const profile of ["profile", "other-profile"]) {
      db.prepare("INSERT INTO storage_profiles VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").run(profile, `r2:fixture:${profile}`, NOW);
    }
    const input = JSON.stringify({ schema: "r2-upload-request/1", ingress: "ordinary_image", purpose: "embedded_content", scope: "system",
      file: { originalName: "source.png", mimeType: "image/png", byteSize: 1, sha256: SHA } });
    db.prepare(`INSERT INTO r2_upload_requests(id,actor_email,client_request_id,operation_id,ingress,purpose,request_sha256,
      request_input_json,request_scope,storage_profile_id,storage_profile_revision,storage_policy_revision,candidate_asset_id,
      candidate_object_key,status,created_at,expires_at)
      VALUES(?,'operator',?,?,'ordinary_image','embedded_content',?,?,'system','profile',1,1,?,'receipt-key','pending',?,?)`)
      .run(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), SHA, input, crypto.randomUUID(), NOW, "2026-09-26T00:00:00.000Z");
    for (const profile of ["profile", "other-profile"]) {
      db.prepare("INSERT INTO files(id,purpose,access_scope,state,created_at) VALUES(?,'embedded_content','system','unresolved',?)").run(profile, NOW);
      db.prepare("INSERT INTO file_locations VALUES(?,?,?,'receipt-key','unresolved',?)").run(profile, profile, profile, NOW);
    }
    expect(db.prepare("SELECT * FROM legacy_file_mappings").all()).toEqual([]);
    enable(db);
    const hold = (profile: string) => db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
      VALUES(?,?,'read','reader','Read exact namespace',?)`).run(profile, profile, NOW);
    const claim = () => db.prepare(`INSERT INTO blob_gc_ledger(store_kind,provider,object_key,state,operation_id,updated_at)
      VALUES('r2','r2','receipt-key','deleting','legacy-gc',?)`).run(NOW);
    if (order === "hold_first") {
      hold("profile");
      expect(claim).toThrow(/retention fences legacy deletion/);
    } else {
      claim();
      expect(() => hold("profile")).toThrow(/hold cannot cross legacy deletion/);
    }
    expect(() => hold("other-profile")).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("requires an indefinite destination hold before a provider write can start", () => {
    for (const expiry of ["2099-01-01T00:00:00.000Z", null]) {
      const db = stagedCandidate();
      destinationHold(db, expiry);
      const start = () => db.prepare("UPDATE file_shadow_attempts SET state='write_started',write_started_at=? WHERE id='attempt'").run(NOW);
      if (expiry === null) expect(start).not.toThrow();
      else expect(start).toThrow(/attempt transition or executor fence/);
    }
  });

  it.each(["staged", "write_started", "unknown", "verified"])("retains the destination while its attempt is %s", (state) => {
    const db = stagedCandidate();
    destinationHold(db);
    if (state !== "staged") db.prepare("UPDATE file_shadow_attempts SET state='write_started',write_started_at=? WHERE id='attempt'").run(NOW);
    if (state === "unknown") db.exec("UPDATE file_shadow_attempts SET state='unknown' WHERE id='attempt'");
    if (state === "verified") db.prepare("UPDATE file_shadow_attempts SET state='verified',verified_at=? WHERE id='attempt'").run(NOW);
    expect(() => db.prepare("UPDATE file_location_holds SET released_at=? WHERE id='destination-hold'").run(NOW))
      .toThrow(/destination hold requires safe terminal reconciliation/);
    expect(db.prepare("SELECT COUNT(*) count FROM file_location_retention_edges WHERE location_id='candidate'").get()?.count).toBe(1);
    db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
      VALUES('unrelated-hold','candidate','read','unrelated','Independent reader',?,'2099-01-01T00:00:00.000Z')`).run(NOW);
    expect(() => db.prepare("UPDATE file_location_holds SET released_at=? WHERE id='unrelated-hold'").run(NOW)).not.toThrow();
  });

  it.each(["cancelled", "resolved"])("releases the destination after its operation is safely %s", (status) => {
    const db = stagedCandidate();
    destinationHold(db);
    if (status === "cancelled") {
      db.prepare("UPDATE file_shadow_attempts SET state='cancelled',completed_at=? WHERE id='attempt'").run(NOW);
      db.prepare("UPDATE file_shadow_operations SET status='cancelled',completed_at=? WHERE id='operation'").run(NOW);
    } else {
      db.exec(`
        UPDATE file_shadow_attempts SET state='write_started',write_started_at='${NOW}' WHERE id='attempt';
        UPDATE file_shadow_attempts SET state='verified',verified_at='${NOW}' WHERE id='attempt';
        INSERT INTO file_location_publications VALUES('candidate','candidate','profile','candidate-key',1,'${SHA}',
          'full_read_sha256','operation','${NOW}','${NOW}');
        INSERT INTO file_publications VALUES('candidate','embedded_content','system',1,'${SHA}','candidate','ready','${NOW}',NULL);
        INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,file_id,location_id,baseline_sha256,decided_by,decided_at)
          SELECT occurrence_id,id,'resolved','candidate','candidate',baseline_sha256,'operator','${NOW}' FROM file_shadow_operations WHERE id='operation';
        UPDATE file_shadow_attempts SET state='published',completed_at='${NOW}' WHERE id='attempt';
        UPDATE file_shadow_operations SET status='resolved',completed_at='${NOW}' WHERE id='operation';
      `);
    }
    expect(() => db.prepare("UPDATE file_location_holds SET released_at=? WHERE id='destination-hold'").run(NOW)).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
