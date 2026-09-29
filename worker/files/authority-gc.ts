import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import { BLOB_ORPHAN_GRACE_MS, BLOB_REGISTRATION_GRACE_MS } from "../blob-lifecycle/reachability";
import { readFileAuthorityMode } from "./authority-reader";
import { legacyByteDeleter } from "./legacy-byte-deleter";
import { openShadowProfile } from "./shadow-profile";

const BATCH_SIZE = 100;
const CLAIM_LEASE_MS = 15 * 60 * 1_000;
const active = "EXISTS (SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard g ON g.singleton=c.singleton WHERE c.singleton=1 AND c.mode='active' AND g.enabled=1)";

// A usable-publications lookup alone would discard quarantined/disabled but
// still retained Files. Physical deletion also respects legacy consumers and
// shadow source holds; a matching key in an unproven namespace retains bytes.
const locationUnretained = `NOT EXISTS (SELECT 1 FROM file_location_retention_edges e WHERE e.location_id=l.id)
AND NOT EXISTS (SELECT 1 FROM file_holds h WHERE h.file_id=l.file_id AND h.released_at IS NULL
  AND (h.expires_at IS NULL OR julianday(h.expires_at)>julianday('now')))
AND NOT EXISTS (SELECT 1 FROM file_shadow_legacy_holds h
  WHERE h.storage_profile_id=l.storage_profile_id AND h.object_key=l.object_key AND h.released_at IS NULL)
AND NOT EXISTS (SELECT 1 FROM blob_retention_edges e JOIN storage_profiles p ON p.id=l.storage_profile_id
  WHERE e.provider=p.adapter_type AND e.object_key=l.object_key
    AND e.store_kind=CASE p.adapter_type WHEN 'r2' THEN 'r2' ELSE 'managed' END)`;
const unretained = `NOT EXISTS (
  SELECT 1 FROM file_publications f WHERE f.active_location_id=l.id AND f.state='ready'
) AND ${locationUnretained}`;

interface LocationWork {
  location_id: string;
  storage_profile_id: string;
  configuration_revision: number;
  object_key: string;
  adapter_type: "r2" | "switchdrive";
  state: "orphaned" | "deleting";
  operation_id: string | null;
}
interface Claim { operation_id: string; attempt_count: number; deletion_started_at: string }
const claimWhere = "location_id=? AND state='deleting' AND operation_id=? AND attempt_count=? AND deletion_started_at=?";
const claimValues = (work: LocationWork, claim: Claim) =>
  [work.location_id, claim.operation_id, claim.attempt_count, claim.deletion_started_at];

/** Active authority owns deletion by immutable location/profile, never by an
 * asset row's legacy key. Terminal receipts release unpublished candidates;
 * unretained ready Files retire after registration grace, before orphan grace.
 * Native guards keep a claimed location unattachable across uncertain DELETEs.
 */
export async function runFileGarbageCollection(env: Env, now = new Date()) {
  const result = { orphanCandidatesMarked: 0, imageDeleted: 0, managedDeleted: 0, failures: 0 };
  const db = primaryD1(env.DB);
  if (await readFileAuthorityMode(db) !== "active") return result;
  const runtime = await db.prepare("SELECT incarnation FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=1")
    .first<{ incarnation: string }>();
  if (!runtime) return result;
  const timestamp = now.toISOString();
  const registrationCutoff = new Date(now.getTime() - BLOB_REGISTRATION_GRACE_MS).toISOString();
  const orphanCutoff = new Date(now.getTime() - BLOB_ORPHAN_GRACE_MS).toISOString();
  const staleCutoff = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  // Original recovery/retry-window maintenance runs first. Receipt expiry alone
  // is never terminal evidence: pending and missing receipts retain candidates.
  await db.batch([
    db.prepare(`UPDATE file_acceptance_candidates SET state='cancelled',completed_at=?
      WHERE ${active} AND (acceptance_kind,acceptance_id,item_id) IN (
        SELECT c.acceptance_kind,c.acceptance_id,c.item_id FROM file_acceptance_candidates c
        WHERE c.state='candidate' AND julianday(c.created_at)<=julianday(?)
          AND NOT EXISTS (SELECT 1 FROM file_publications f WHERE f.file_id=c.candidate_file_id)
          AND ((c.acceptance_kind='r2_upload' AND EXISTS (
            SELECT 1 FROM r2_upload_requests r WHERE r.id=c.acceptance_id
              AND r.status IN ('ready','failed') AND r.completed_at IS NOT NULL))
          OR (c.acceptance_kind='metrology_reference' AND EXISTS (
            SELECT 1 FROM metrology_reference_upload_requests r WHERE r.id=c.acceptance_id
              AND r.status IN ('ready','failed') AND r.completed_at IS NOT NULL))
          OR (c.acceptance_kind='comment_item' AND EXISTS (
            SELECT 1 FROM comment_item_acceptances r WHERE r.item_id=c.acceptance_id
              AND r.status IN ('ready','cancelled')))
          OR (c.acceptance_kind='import_file' AND EXISTS (
            SELECT 1 FROM imports i WHERE i.id=c.acceptance_id AND i.client_request_id IS NOT NULL
              AND i.completed_at IS NOT NULL AND ((i.status='ready' AND i.finalization_id IS NOT NULL)
                OR (i.status='failed' AND i.recovery_operation_id IS NOT NULL
                  AND i.finalization_id IS NULL AND i.lease_expires_at IS NULL)))))
        ORDER BY c.created_at,c.acceptance_kind,c.acceptance_id,c.item_id LIMIT ?)`)
      .bind(timestamp, registrationCutoff, BATCH_SIZE),
    db.prepare(`UPDATE file_publications SET state='retired',active_location_id=NULL,retired_at=?
      WHERE ${active} AND file_id IN (
        SELECT f.file_id FROM file_publications f JOIN file_locations l ON l.id=f.active_location_id
        WHERE f.state='ready' AND julianday(f.published_at)<=julianday(?)
          AND julianday(l.created_at)<=julianday(?)
          AND NOT EXISTS (SELECT 1 FROM file_retention_edges e WHERE e.file_id=f.file_id)
          AND ${locationUnretained}
        ORDER BY f.published_at,f.file_id LIMIT ?)`)
      .bind(timestamp, registrationCutoff, registrationCutoff, BATCH_SIZE),
  ]);
  const marked = await db.prepare(`INSERT INTO file_location_gc_ledger
    (location_id,state,operation_id,orphaned_at,deletion_started_at,deleted_at,attempt_count,last_error,updated_at)
    SELECT l.id,'orphaned',NULL,?,NULL,NULL,0,NULL,? FROM file_locations l
    WHERE ${active} AND julianday(l.created_at)<=julianday(?)
      AND NOT EXISTS (SELECT 1 FROM file_location_gc_ledger g WHERE g.location_id=l.id)
      AND (EXISTS (SELECT 1 FROM file_location_publications p WHERE p.location_id=l.id)
        OR EXISTS (SELECT 1 FROM file_acceptance_candidates c
          WHERE c.candidate_location_id=l.id AND c.state IN ('ready','cancelled')))
      AND ${unretained}
    ORDER BY l.created_at,l.id LIMIT ?`)
    .bind(timestamp, timestamp, registrationCutoff, BATCH_SIZE).run();
  result.orphanCandidatesMarked = marked.meta.changes ?? 0;

  const work = await db.prepare(`SELECT g.location_id,g.state,g.operation_id,
    l.storage_profile_id,l.object_key,p.configuration_revision,p.adapter_type
    FROM file_location_gc_ledger g JOIN file_locations l ON l.id=g.location_id
    JOIN storage_profiles p ON p.id=l.storage_profile_id
    JOIN storage_profile_runtime r ON r.storage_profile_id=p.id AND r.state='read_write'
    WHERE ${active} AND ((g.state='orphaned' AND julianday(g.orphaned_at)<=julianday(?))
      OR (g.state='deleting' AND julianday(g.deletion_started_at)<=julianday(?)))
      AND ${unretained}
    ORDER BY CASE g.state WHEN 'deleting' THEN 0 ELSE 1 END,g.orphaned_at,g.location_id LIMIT ?`)
    .bind(orphanCutoff, staleCutoff, BATCH_SIZE).all<LocationWork>();

  for (const location of work.results) {
    const retry = location.state === "deleting";
    const operationId = retry ? location.operation_id! : crypto.randomUUID();
    const claim = await db.prepare(`UPDATE file_location_gc_ledger SET state='deleting',operation_id=?,
      deletion_started_at=?,attempt_count=attempt_count+1,last_error=NULL,updated_at=?
      WHERE location_id=? AND ${active}
        AND ${retry ? "state='deleting' AND operation_id=? AND julianday(deletion_started_at)<=julianday(?)"
          : "state='orphaned' AND julianday(orphaned_at)<=julianday(?)"}
        AND EXISTS (SELECT 1 FROM file_locations l JOIN storage_profile_runtime r
          ON r.storage_profile_id=l.storage_profile_id AND r.state='read_write'
          WHERE l.id=file_location_gc_ledger.location_id AND ${unretained})
      RETURNING operation_id,attempt_count,deletion_started_at`)
      .bind(operationId, timestamp, timestamp, location.location_id,
        ...(retry ? [operationId, staleCutoff] : [orphanCutoff])).first<Claim>();
    if (!claim) continue;
    let failure: string | null = null;
    try {
      const profile = await openShadowProfile(env, {
        profileId: location.storage_profile_id, configurationRevision: location.configuration_revision,
      }, "write");
      // The profile opener already proved this configured adapter is the exact
      // persisted physical namespace. No role default or fallback is selected.
      const deleter = legacyByteDeleter(env, {
        storeKind: profile.storage.adapterType === "r2" ? "r2" : "managed", provider: profile.storage.adapterType,
      });
      const ownsClaim = async () => Boolean(await db.prepare(`SELECT 1 FROM file_location_gc_ledger
        WHERE ${claimWhere} AND ${active} AND EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND incarnation=?)`)
        .bind(...claimValues(location, claim), runtime.incarnation).first());
      let missing = false;
      if (!await ownsClaim()) failure = "deletion_claim_changed";
      if (!failure && retry) {
        const observed = await profile.reader.stat(location.object_key);
        missing = observed.outcome === "missing";
        if (!missing && observed.outcome !== "available") failure = "deletion_confirmation_unavailable";
      }
      if (!failure && !missing) {
        if (!await ownsClaim()) failure = "deletion_claim_changed";
        else {
          const deleted = await deleter.delete(location.object_key);
          if (deleted.outcome !== "acknowledged") failure = deleted.outcome === "denied" ? "deletion_denied" : "deletion_unavailable";
        }
      }
      if (!failure) {
        const finalized = await db.prepare(`UPDATE file_location_gc_ledger
          SET state='deleted',deleted_at=?,last_error=NULL,updated_at=? WHERE ${claimWhere}`)
          .bind(timestamp, timestamp, ...claimValues(location, claim)).run();
        if (!finalized.meta.changes) failure = "deletion_claim_changed";
        else if (location.adapter_type === "r2") result.imageDeleted++;
        else result.managedDeleted++;
      }
    } catch { failure = "deletion_unavailable"; }
    if (failure) {
      result.failures++;
      await db.prepare(`UPDATE file_location_gc_ledger SET last_error=?,updated_at=? WHERE ${claimWhere}`)
        .bind(failure, timestamp, ...claimValues(location, claim)).run();
    }
  }
  return result;
}
