import type { FilePurpose } from "../../shared/contracts/files";
import { primaryD1 } from "../d1-primary";
import { validateByteExpectation } from "./byte-verification";

export type AuthorityCandidateOwner = {
  kind: "r2_upload" | "metrology_reference" | "comment_item" | "import_file";
  acceptanceId: string;
  actorEmail: string;
  operationId: string;
  /** Import receipt item: workbook, manifest, or image:<localId>. */
  itemId?: string;
  /** The already claimed Comment upload token, never a newly generated token. */
  executionToken?: string;
};

export interface StagedAuthorityCandidate {
  state: "staged";
  acceptance: { kind: AuthorityCandidateOwner["kind"]; id: string; itemId: string };
  operationId: string;
  purpose: FilePurpose;
  accessScope: "system";
  profile: { profileId: string; configurationRevision: 1 };
  expectedBytes: { byteSize: number; sha256: string };
  fileId: string;
  locationId: string;
  objectKey: string;
}

export class AuthorityCandidateUnavailableError extends Error {
  constructor() { super("The accepted File candidate is unavailable or changed."); this.name = "AuthorityCandidateUnavailableError"; }
}

interface Receipt {
  purpose: FilePurpose;
  access_scope: "system";
  storage_profile_id: string;
  configuration_revision: 1;
  expected_byte_size: number;
  expected_sha256: string;
  candidate_object_key: string | null;
}
interface Candidate {
  purpose: FilePurpose;
  access_scope: "system";
  storage_profile_id: string;
  expected_byte_size: number;
  expected_sha256: string;
  candidate_file_id: string;
  candidate_location_id: string;
  candidate_object_key: string;
  state: "candidate" | "ready" | "cancelled";
}

const purposes: readonly FilePurpose[] = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"];
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}
function checkedOwner(input: AuthorityCandidateOwner): AuthorityCandidateOwner {
  if (!input || !["r2_upload", "metrology_reference", "comment_item", "import_file"].includes(input.kind)
    || !text(input.acceptanceId) || !text(input.actorEmail) || !text(input.operationId)
    || (input.kind === "import_file" ? !text(input.itemId, 4096) : input.itemId !== undefined && input.itemId !== "")
    || (input.kind === "comment_item" ? !text(input.executionToken) : input.executionToken !== undefined)) throw new AuthorityCandidateUnavailableError();
  return { ...input };
}

/** These are the existing receipt ownership predicates, not a second executor
 * protocol. All metadata comes from the accepted row; callers supply no purpose,
 * profile, hash, size, or replacement object key. */
function receiptSql(owner: AuthorityCandidateOwner): string {
  let receipt: string;
  if (owner.kind === "r2_upload" || owner.kind === "metrology_reference") {
    const table = owner.kind === "r2_upload" ? "r2_upload_requests" : "metrology_reference_upload_requests";
    receipt = `SELECT purpose,request_scope access_scope,storage_profile_id,storage_profile_revision configuration_revision,
      json_extract(request_input_json,'$.file.byteSize') expected_byte_size,
      json_extract(request_input_json,'$.file.sha256') expected_sha256,candidate_object_key
      FROM ${table} WHERE id=?1 AND actor_email=?2 AND operation_id=?3 AND status='pending' AND expires_at>?4 AND ?5=''`;
  } else if (owner.kind === "comment_item") {
    receipt = `SELECT item.purpose,parent.request_scope access_scope,item.storage_profile_id,item.storage_profile_revision configuration_revision,
      item.expected_byte_size,item.expected_sha256,item.candidate_object_key
      FROM comment_item_acceptances item JOIN comment_submission_acceptances parent ON parent.submission_id=item.submission_id
      JOIN comment_submissions submission ON submission.id=parent.submission_id
      JOIN comment_submission_items source ON source.id=item.item_id AND source.submission_id=item.submission_id
      WHERE item.item_id=?1 AND item.actor_email=?2 AND parent.actor_email=?2 AND parent.operation_id=?3
        AND item.execution_token=?5 AND item.status='pending' AND parent.status='pending' AND parent.expires_at>?4
        AND submission.status NOT IN('ready','cancelled') AND submission.retry_closed_at IS NULL AND submission.deleted_at IS NULL
        AND source.status<>'cancelled' AND source.deleted_at IS NULL`;
  } else {
    receipt = `SELECT json_extract(entry.value,'$.purpose') purpose,r.request_scope access_scope,r.storage_profile_id,
      r.storage_profile_revision configuration_revision,json_extract(entry.value,'$.byteSize') expected_byte_size,
      json_extract(entry.value,'$.sha256') expected_sha256,NULL candidate_object_key
      FROM imports r JOIN json_each(CASE WHEN ?5='workbook' THEN json_array(json_extract(r.request_input_json,'$.workbook'))
        WHEN ?5='manifest' THEN json_array(json_extract(r.request_input_json,'$.manifest'))
        WHEN substr(?5,1,6)='image:' THEN json_extract(r.request_input_json,'$.images') ELSE '[]' END) entry
      WHERE r.id=?1 AND r.actor_email=?2 AND r.operation_id=?3 AND r.status='pending' AND r.client_request_id IS NOT NULL
        AND r.lease_expires_at>?4 AND (?5 IN('workbook','manifest') OR json_extract(entry.value,'$.localId')=substr(?5,7))`;
  }
  return `SELECT receipt.* FROM (${receipt}) receipt
    JOIN storage_profiles p ON p.id=receipt.storage_profile_id AND p.configuration_revision=receipt.configuration_revision
    JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id AND runtime.state='read_write'
    JOIN file_authority_control authority ON authority.singleton=1 AND authority.mode IN('overlap','active')`;
}

function receiptBindings(owner: AuthorityCandidateOwner, now: string) {
  return [owner.acceptanceId, owner.actorEmail, owner.operationId, now,
    owner.kind === "comment_item" ? owner.executionToken! : owner.itemId ?? ""];
}
function candidateStatement(db: D1Database, owner: AuthorityCandidateOwner) {
  return db.prepare(`SELECT purpose,access_scope,storage_profile_id,expected_byte_size,expected_sha256,
    candidate_file_id,candidate_location_id,candidate_object_key,state FROM file_acceptance_candidates
    WHERE acceptance_kind=? AND acceptance_id=? AND item_id=?`)
    .bind(owner.kind, owner.acceptanceId, owner.itemId ?? "");
}
function staged(owner: AuthorityCandidateOwner, receipt: Receipt, candidate: Candidate | null | undefined): StagedAuthorityCandidate {
  if (!candidate || candidate.state !== "candidate" || candidate.purpose !== receipt.purpose || candidate.access_scope !== receipt.access_scope
    || candidate.storage_profile_id !== receipt.storage_profile_id || candidate.expected_byte_size !== receipt.expected_byte_size
    || candidate.expected_sha256 !== receipt.expected_sha256
    || receipt.candidate_object_key !== null && candidate.candidate_object_key !== receipt.candidate_object_key
    || !text(candidate.candidate_file_id) || !text(candidate.candidate_location_id) || !text(candidate.candidate_object_key, 4096)) throw new AuthorityCandidateUnavailableError();
  return { state: "staged", acceptance: { kind: owner.kind, id: owner.acceptanceId, itemId: owner.itemId ?? "" },
    operationId: owner.operationId, purpose: receipt.purpose, accessScope: "system",
    profile: { profileId: receipt.storage_profile_id, configurationRevision: 1 },
    expectedBytes: { byteSize: receipt.expected_byte_size, sha256: receipt.expected_sha256 },
    fileId: candidate.candidate_file_id, locationId: candidate.candidate_location_id, objectKey: candidate.candidate_object_key };
}

/** Stage metadata for an already-owned accepted writer. This neither claims a
 * new executor nor grants permission to repeat a PUT. In particular, replay or
 * lost-ack readback returns the same staging row, never new write ownership.
 * Existing candidate retention protects the placement without a new ledger.
 * No bytes are read/written, no publication is inserted, and no receipt becomes
 * ready. The accepted writer must keep its existing ownership/replay protocol. */
export async function stageAuthorityCandidate(database: D1Database, input: AuthorityCandidateOwner,
  now = new Date().toISOString()): Promise<StagedAuthorityCandidate> {
  const owner = checkedOwner(input), db = primaryD1(database);
  try {
    if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new AuthorityCandidateUnavailableError();
    const sql = receiptSql(owner), bindings = receiptBindings(owner, now);
    const receipts = await db.prepare(sql).bind(...bindings).all<Receipt>();
    if (!receipts.success || receipts.results.length !== 1) throw new AuthorityCandidateUnavailableError();
    const receipt = receipts.results[0];
    if (!purposes.includes(receipt.purpose) || receipt.access_scope !== "system" || receipt.configuration_revision !== 1
      || !text(receipt.storage_profile_id) || receipt.candidate_object_key !== null && !text(receipt.candidate_object_key, 4096)) throw new AuthorityCandidateUnavailableError();
    validateByteExpectation({ byteSize: receipt.expected_byte_size, sha256: receipt.expected_sha256 }, "source");
    const fileId = crypto.randomUUID(), locationId = crypto.randomUUID();
    const objectKey = receipt.candidate_object_key ?? `files/${fileId}`;
    try {
      const result = await db.batch([
        // Recheck owner, expiry, profile access and mode in the same transaction
        // as every insert. The frozen receipt fields cannot be edited in place.
        db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM (${sql}))=1 THEN 1
          ELSE json('Accepted File owner changed') END`).bind(...bindings),
        db.prepare(`INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at)
          SELECT ?,?,'system',?,?,'unresolved',? WHERE NOT EXISTS(SELECT 1 FROM file_acceptance_candidates
            WHERE acceptance_kind=? AND acceptance_id=? AND item_id=?)`)
          .bind(fileId, receipt.purpose, receipt.expected_byte_size, receipt.expected_sha256, now, owner.kind, owner.acceptanceId, owner.itemId ?? ""),
        db.prepare(`INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at)
          SELECT ?,?,?,?,'unresolved',? WHERE EXISTS(SELECT 1 FROM files WHERE id=?)`)
          .bind(locationId, fileId, receipt.storage_profile_id, objectKey, now, fileId),
        db.prepare(`INSERT INTO file_acceptance_candidates(acceptance_kind,acceptance_id,item_id,purpose,access_scope,
          storage_profile_id,expected_byte_size,expected_sha256,candidate_file_id,candidate_location_id,candidate_object_key,state,created_at)
          SELECT ?,?,?,?,'system',?,?,?,?,?,?,'candidate',? WHERE EXISTS(SELECT 1 FROM file_locations WHERE id=?)`)
          .bind(owner.kind, owner.acceptanceId, owner.itemId ?? "", receipt.purpose, receipt.storage_profile_id,
            receipt.expected_byte_size, receipt.expected_sha256, fileId, locationId, objectKey, now, locationId),
        candidateStatement(db, owner),
      ]);
      if (result.some(entry => !entry.success)) throw new AuthorityCandidateUnavailableError();
      return staged(owner, receipt, result.at(-1)!.results[0] as unknown as Candidate | undefined);
    } catch {
      // A batch acknowledgement can be lost after commit. Reconcile only the
      // original receipt/candidate, with ownership and eligibility still intact.
      const current = await db.prepare(sql).bind(...bindings).all<Receipt>();
      if (!current.success || current.results.length !== 1) throw new AuthorityCandidateUnavailableError();
      return staged(owner, current.results[0], await candidateStatement(db, owner).first<Candidate>());
    }
  } catch { throw new AuthorityCandidateUnavailableError(); }
}

/** Metadata selection only. This does not verify current provider bytes, hold a
 * read lease, publish a candidate, or make the selected File a durable result.
 * Final publication must recheck the tuple in its own guarded transaction. */
export async function findReusableAuthorityFile(database: D1Database, candidate: StagedAuthorityCandidate): Promise<{
  fileId: string; locationId: string; objectKey: string;
} | null> {
  const row = await primaryD1(database).prepare(`SELECT fp.file_id fileId,fp.active_location_id locationId,flp.object_key objectKey
    FROM file_acceptance_candidates c JOIN file_usable_publications fp
      ON fp.purpose=c.purpose AND fp.access_scope=c.access_scope
      AND fp.verified_byte_size=c.expected_byte_size AND fp.verified_sha256=c.expected_sha256
    JOIN file_location_publications flp ON flp.location_id=fp.active_location_id AND flp.file_id=fp.file_id
      AND flp.storage_profile_id=c.storage_profile_id
    JOIN storage_profiles p ON p.id=c.storage_profile_id AND p.configuration_revision=?
    JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id AND runtime.state='read_write'
    WHERE c.acceptance_kind=? AND c.acceptance_id=? AND c.item_id=? AND c.state='candidate'
      AND c.candidate_file_id=? AND c.candidate_location_id=? AND c.candidate_object_key=?
      AND c.purpose=? AND c.access_scope=? AND c.storage_profile_id=? AND c.expected_byte_size=? AND c.expected_sha256=?
    ORDER BY fp.published_at,fp.file_id LIMIT 1`)
    .bind(candidate.profile.configurationRevision, candidate.acceptance.kind, candidate.acceptance.id, candidate.acceptance.itemId,
      candidate.fileId, candidate.locationId, candidate.objectKey, candidate.purpose, candidate.accessScope,
      candidate.profile.profileId, candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256)
    .first<{ fileId: string; locationId: string; objectKey: string }>();
  return row ?? null;
}
