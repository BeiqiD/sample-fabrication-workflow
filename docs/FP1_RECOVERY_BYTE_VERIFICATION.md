# FP1e: complete-byte verification during import recovery

Status: bounded integrity correction after [FP1d](./FP1_FENCED_BYTE_DELETION.md).
Development base: `492b552` on `v2/backend-foundation`, 2026-09-13.
The full File authority audit exposed this gap in independently invoked recovery.
This correction does not activate the dormant registry or complete FP1.

## Problem and recovery boundary

[FP1c](./FP1_VERIFIED_BYTE_WRITES.md) verifies new uploads and selected reuse in
the importing request. Independently invoked FabuBlox recovery previously checked
only object size when an asset already had a SHA-256. Its canonical replacement
lookup also depended on metadata-only reuse checks. Equal-length corrupt bytes
could therefore become public or replace surviving references during recovery.
The legacy null-SHA path read the entire object into an ArrayBuffer.

Recovery must read every selected source or canonical replacement whose bytes it
will certify. Known hashes are expectations to compare against complete bytes,
not proof. A legacy missing hash may be reconstructed only after successful EOF
and an exact expected-size match. Verification uses the bound R2 instance and
incremental SHA-256, with the existing 100 MiB ceiling and bounded hash writes.
It does not accumulate an object-sized buffer or treat HEAD/ETag as content proof.

An equal-length checksum mismatch, unavailable read, incomplete stream or invalid
expectation prevents the durable cleanup claim. The import remains retryable;
recovery does not erase its expected hash, redirect its consumers or promote its
asset. Error messages exclude provider exception text. Existing missing/size
quarantine behavior remains distinct: this change does not mislabel checksum
corruption with an unrelated quarantine reason.

An overlong stream is cancelled as soon as it exceeds the expectation. Its
recorded observed size is the prefix received before cancellation, not a claim
about the complete object's length.

Complete byte evidence precedes the atomic, operation-guarded cleanup. An adjacent
snapshot assertion checks the entire source inventory, original key/hash/size/
status, quarantine and GC state, and each canonical's verified identity and
current public availability. A mismatch rolls back the claim and all cleanup.
The assertion consumes the claim UPDATE's affected-row count in the same batch;
a competing finalization that already won remains a no-op. Public consumer
retention, private ownership transfer and canonical occurrence supersession keep
their existing semantics. Neither verification nor failed verification owns a
provider write or deletion.

## Evidence limits

The evidence describes a complete read at a particular time. It does not pin an
object version or protect against later external mutation of the same key.
Historical ready assets are not retroactively certified by this correction.
The existing hash-mismatch handling rejects the recovery attempt without adding
a durable checksum-quarantine schema or a new automatic repair operation.

No schema, archive format, profile/default, storage binding, credential or Cron
change is part of this correction. The current schema 9 / writer 1 /
`fp1-legacy-overlap` contract remains in force. ZIP-specific and browser ZIP
acceptance remain deferred at the owner's request. Mandatory existing restore
regressions remain part of the normal gate.

Qualification includes known/unknown SHA, equal-length corruption, canonical
replacement corruption, missing/short/failed reads, cancellation and preserved
recovery ownership. Native fixtures use local workerd, real D1 and R2, and the
Worker incremental digest capability. They do not certify the remote deployment's
CPU quota or live provider fault behavior. The PR records executed validation,
independent review, deployment and applicable browser acceptance.

## Concrete handoff for complete File authority

The [FP1d consumer inventory](./FP1_FENCED_BYTE_DELETION.md#next-authority-transition-complete-inventory)
and [implementation gates](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md#schema-and-api-transition-strategy)
still apply together. The audit identified these implementation requirements:

| Area | Required change before activation |
| --- | --- |
| Forward schema | Rebuild the four FP1a tables under new constraints while preserving all original observations. Removing immutability triggers alone cannot change their dormant-state CHECK constraints. |
| Typed consumers | Add explicit File foreign keys to relational occurrences and direct provenance/thumbnail roots. One `assets.file_id` cannot represent all purposes of a shared historical key. |
| Shared legacy bytes | Preserve first observations; classify actual consumers. Different purposes need independent verified placements before becoming separately ready. Unclassified or unavailable sources retain their compatibility reads and retention holds. |
| Accepted operations | Persist stable client retry identity, actor/scope, purpose, immutable input, destination profile and policy revision before dedup/I/O. Current per-request random FabuBlox operation IDs do not provide this retry contract. |
| Dedup | Replace R2 global-SHA and managed provider/hash uniqueness together with complete consumer conversion. FabuBlox batch-local reuse must include purpose, scope, profile and size as well as hash. |
| Namespace | Supply a trusted physical R2 account/bucket identity to runtime composition. Existing generated config knows the bucket name and D1 UUID, but neither establishes the R2 account namespace. Binding labels are insufficient. SWITCHdrive identity includes canonical endpoint/account/root, excluding the password. |
| Reads and hashes | Preserve authorized business URLs such as Project content URLs. Change source guards that currently include `r2_key` to stable logical/content identities without changing research hash schemes. Comment original download paths must support both storage adapters. |
| Recovery protocol | Introduce a new schema/profile with an exact catalog for active File/location/operation state. Keep V7/V8/V9 validators unchanged and restore each historical format before reviewed forward upgrades. Do not replay historical cleanup operations automatically. |

Complete retention, quarantine, deletion fencing, recovery and compatibility
coverage are required before enabling active File locations. R2 defaults for new
originals and authenticated storage Settings follow that transition. A normal
reviewed deployment already applies forward migrations; no Cloudflare dashboard
login is needed merely to implement or deploy them.
