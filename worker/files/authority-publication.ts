import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import {
  authorityCandidatePublicationFence, findReusableAuthorityFile,
  type AuthorityCandidateOwner, type StagedAuthorityCandidate,
} from "./authority-candidates";
import { writeVerifiedBytes, type ByteWriteInput } from "./byte-writer";
import { openShadowProfile } from "./shadow-profile";
import { ByteVerificationError, verifyByteStream } from "./byte-verification";

export interface VerifiedAuthorityPublication {
  /** Bytes are verified; no File or receipt has been published by this call. */
  state: "verified_unpublished";
  result: { fileId: string; locationId: string; objectKey: string };
  statements: D1PreparedStatement[];
}

/** Only a fresh executor already admitted by its accepted writer may call this.
 * It does one PUT and a complete readback; an uncertain write is never retried
 * or deleted here. Receipt replay uses the read path, not this function.
 *
 * Execute the returned statements first, followed by the writer's receipt
 * completion and typed business binding, in ONE db.batch. A failure leaves the
 * existing candidate retaining its placement; it does not authorize another
 * write. The result is not ready until that entire batch commits.
 *
 * Current 0008 shadow-only publication guards still reject these statements.
 * This is the future active writer substrate, not authority activation. */
export async function writeAuthorityCandidate(
  env: Env, ownerInput: AuthorityCandidateOwner, candidateInput: StagedAuthorityCandidate,
  input: Pick<ByteWriteInput, "body" | "contentType" | "filename">,
): Promise<VerifiedAuthorityPublication> {
  const owner = { ...ownerInput };
  const candidate = { ...candidateInput, acceptance: { ...candidateInput.acceptance },
    profile: { ...candidateInput.profile }, expectedBytes: { ...candidateInput.expectedBytes } };
  const payload = { ...input };
  const db = primaryD1(env.DB);
  await authorityCandidatePublicationFence(db, owner, candidate).first();
  const profile = await openShadowProfile(env, candidate.profile, "write", {
    beforeRequest: async () => {
      try {
        await authorityCandidatePublicationFence(primaryD1(env.DB), owner, candidate).first();
        return true;
      } catch { return false; }
    },
  });
  if (!profile.writer) throw new Error("The accepted File writer is unavailable");
  const verified = await writeVerifiedBytes({ reader: profile.reader, writer: profile.writer, createHash: profile.createHash }, {
    ...payload, key: candidate.objectKey, ...candidate.expectedBytes,
  });
  // Accepted browser previews prove their bytes, not how they were derived.
  // They must not enter the reusable, trusted derivative cache by hash alone.
  let reusable = candidate.purpose === "derived_preview" ? null : await findReusableAuthorityFile(db, candidate);
  if (reusable) {
    const previous = await profile.reader.read(reusable.objectKey);
    if (previous.outcome !== "available") reusable = null;
    else {
      try { await verifyByteStream(previous.body, candidate.expectedBytes, profile.createHash, "destination"); }
      catch (error) {
        if (!(error instanceof ByteVerificationError)) throw error;
        reusable = null;
      }
    }
  }
  const result = reusable ?? { fileId: candidate.fileId, locationId: candidate.locationId, objectKey: candidate.objectKey };
  const now = new Date().toISOString();
  const statements = [
    authorityCandidatePublicationFence(db, owner, candidate),
    // Even a deduplicated result retains proof that this owned candidate's
    // actual bytes were fully verified; candidate-ready requires that proof.
    db.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,
      verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
      VALUES(?,?,?,?,?,?,'full_read_sha256',?,?,?)`)
      .bind(candidate.locationId, candidate.fileId, candidate.profile.profileId, candidate.objectKey,
        verified.byteSize, verified.sha256, owner.operationId, now, now),
    ...(!reusable ? [db.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,
      verified_sha256,active_location_id,state,published_at) VALUES(?,?,?,?,?,?,'ready',?)`)
      .bind(candidate.fileId, candidate.purpose, candidate.accessScope, verified.byteSize, verified.sha256, candidate.locationId, now)] : []),
    // Native guards recheck the reusable result's purpose/scope/profile/bytes,
    // its active location and availability in this same transaction.
    db.prepare(`UPDATE file_acceptance_candidates SET state='ready',result_file_id=?,result_location_id=?,completed_at=?
      WHERE acceptance_kind=? AND acceptance_id=? AND item_id=? AND state='candidate'
        AND candidate_file_id=? AND candidate_location_id=?`)
      .bind(result.fileId, result.locationId, now, candidate.acceptance.kind, candidate.acceptance.id,
        candidate.acceptance.itemId, candidate.fileId, candidate.locationId),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_acceptance_candidates
      WHERE acceptance_kind=? AND acceptance_id=? AND item_id=? AND state='ready'
        AND result_file_id=? AND result_location_id=?) THEN 1 ELSE json('File candidate publication changed') END`)
      .bind(candidate.acceptance.kind, candidate.acceptance.id, candidate.acceptance.itemId, result.fileId, result.locationId),
  ];
  return { state: "verified_unpublished", result, statements };
}
