import { checkedFileShadowEvidenceReview, checkedFileShadowReviewKey, type FileShadowEvidenceReview } from "../../shared/contracts/file-shadow-evidence-review";
import type { LiveConsumerDatabase, LiveConsumerKey } from "./live-consumer-baseline";
import { readShadowBaselineWithIdentification } from "./shadow-baseline";

/** Metadata capability only: one primary SELECT, no service/provider or writer. */
export async function readShadowEvidenceReview(database: LiveConsumerDatabase, input: LiveConsumerKey): Promise<FileShadowEvidenceReview> {
  const key = checkedFileShadowReviewKey(input);
  const { baseline, identification } = await readShadowBaselineWithIdentification(database, key);
  const registry = baseline.record?.registries.length === 1 ? baseline.record.registries[0] : null;
  const expectedBytes = Number.isSafeInteger(registry?.byte_size) && Number(registry?.byte_size) >= 0 ? registry!.byte_size : null;
  const expectedSha256 = typeof registry?.sha256 === "string" && /^[a-f0-9]{64}$/.test(registry.sha256) ? registry.sha256 : null;
  return checkedFileShadowEvidenceReview({ version: 1, kind: "file-shadow-evidence-review", readOnly: true, bytesVerified: false,
    key: baseline.key, head: baseline.head ? { generation: baseline.head.generation, occurrenceId: baseline.head.occurrence_id,
      sourceMetadataSha256: baseline.head.source_sha256 } : null,
    baselineSha256: baseline.baselineSha256, status: baseline.status, reasons: baseline.reasons, identification, purpose: baseline.purpose,
    expectedBytes, expectedSha256, sourceProvider: baseline.sourceLocator ? baseline.sourceLocator.provider === "r2" ? "r2" : "other" : null,
    sourceProfile: baseline.sourceProfile,
    peerReferences: (baseline.record?.peers ?? []).filter(peer => !(peer.consumer_kind === key.consumerKind && peer.consumer_id === key.consumerId
      && peer.consumer_sub_id === key.consumerSubId && peer.file_slot === key.fileSlot)).map(peer => ({ key: { consumerKind: peer.consumer_kind, consumerId: peer.consumer_id,
      consumerSubId: peer.consumer_sub_id, fileSlot: peer.file_slot }, purpose: peer.purpose })),
  });
}
