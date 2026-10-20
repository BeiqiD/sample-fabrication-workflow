# FP2 native File runtime and exact deployment bindings

Migration `0018_fp2_native_file_runtime.sql` is the successor to the immutable
native-profile admission generation. V21 provides its paired portable content
and recovery model; migration `0019_fp3_file_jobs.sql` and V22 add durable jobs.
The frozen V7–V20 readers, admission receipts and earlier SQL files retain their
original contracts.

## Physical identity, activation and credential rotation

`storage_profiles.id` and configuration revision 1 identify one immutable physical
namespace. A native S3 profile retains its original read-only admission receipt
after activation. Replaying registration returns that original receipt even when
the current installation has activated, retired or lost access to credentials.

`storage_profile_activations` is immutable portable audit history.
`system_storage_native_bindings` holds installation-local capability bindings and
is excluded from content archives. An activation atomically records the audit,
binds an exact tested candidate revision and credential/check envelope, and
updates runtime access. Both local binding updates and portable activation
history advance through explicit compare-and-swap commands. Activation revisions
remain globally monotonic after a restore that retains audit history but removes
local credentials and bindings.

Editing a candidate's latest revision cannot retarget an active physical profile.
Credential re-enveloping may advance the current authenticated envelope for the
explicit retained credential descriptor. Opening an operation captures the
current envelope, audit head, binding, profile and runtime state. Immediately
after SigV4 signing, the transport runs the caller's lifecycle fence and rechecks
that exact snapshot against primary D1 before provider I/O. The operation callback
receives only a frozen method/key pair. False, exceptions and changed bindings
produce sanitized unavailable outcomes. A provider request that has already been
sent keeps its actual outcome; there is no automatic retry or replacement PUT.

The exact profile opener exposes readers, verified writers and deleters for R2,
historical SWITCHdrive and activated native AWS S3. It accepts invocation abort
signals and caller lifecycle fences. Native and SWITCHdrive HTTP requests receive
the signal; R2 read streams support cancellation. R2 bindings expose no abort
parameter for an already-started PUT, so durable migration holds preserve an
uncertain write until the job reconciles it.

## Accepted targets and stable File aliases

`storage_role_policy_revisions` records both `internal` and `originals` selections
for every accepted policy revision. New policies can independently select an
available writable R2 or activated native S3 profile. Receipt target selection
captures physical profile identity and purpose before any business byte write.

Historical receipt format markers remain distinct from mutable role policy:

| Receipt | Historical format | New actual selection revision |
| --- | --- | --- |
| Ordinary/Project upload | `storage_policy_revision = 1` | `role_policy_revision >= 3` |
| Metrology reference | `storage_policy_revision = 1` | `role_policy_revision >= 3` |
| Comment parent | `storage_role_policy_revision` formats 1/2; new format 3 | `role_selection_revision >= 3` |
| Comment item | Captured parent format | `role_selection_revision >= 3` |
| FabuBlox import | Historical whole-import target with protocol NULL | `file_targets_protocol = 1`, actual `role_policy_revision >= 3` |

Protocol-1 imports keep every old whole-target field, including
`storage_policy_revision`, NULL. `import_file_acceptances` records an explicit
target for workbook, manifest and every image. Candidate staging requires the
complete input-matching target set; a missing companion cannot fall back to a
historical whole-import target. Publication requires every owned target's exact
verified File/location result before the parent becomes ready.

Native `assets` rows have `r2_key = NULL` and a complete immutable
`file_id`/`storage_profile_id`/`storage_profile_revision`/`object_key` tuple. Existing
R2 rows retain their original fields and rowids; all added alias fields remain
NULL. Native business URLs use `/api/file-assets/:assetId`, preserving all
historical `/api/assets/*` opaque keys. Authorization resolves the business alias
and follows the File's published active location, including after migration.
The alias's original accepted placement remains immutable provenance.

Full source hashing, destination readback and publication precede a ready
receipt. SQL guards preserve the verified candidate, purpose, bytes, hash,
acceptance owner, alias and consumer bindings in the final atomic batch.
Native verification detachment keeps the immutable evidence and releases live
retention only for its exact acknowledged event/verification/asset/File tuple.

## Additional deployment-owned R2 instances

`R2_PROFILE_BINDINGS` is an optional JSON object keyed by an already-registered
physical profile ID. Each value contains exactly `namespaceIdentity` and
`bindingName`:

```json
{
  "registered-secondary-profile": {
    "namespaceIdentity": "{\"kind\":\"local-r2\",\"installationId\":\"10000000-0000-4000-8000-000000000001\",\"bucketName\":\"secondary-bucket\"}",
    "bindingName": "R2_SECONDARY"
  }
}
```

The deployment supplies the actual `R2_SECONDARY` bucket binding. The map is
limited to 100 entries and 256 KiB, uses own-property lookups and uppercase
binding names, and requires exact canonical namespace metadata. An explicit
unavailable entry fails closed. Unlisted profiles use the existing exact
`ASSETS`/`R2_BOOTSTRAP_NAMESPACE` declaration. One binding name or capability
object cannot represent different physical namespaces; an `ASSETS` entry must
match the bootstrap namespace.

This configuration neither registers profiles nor probes provider health.
Runtime reads and writes capture the raw map and actual capability object, then
revalidate them after caller lifecycle checks. Role selection requires complete
bucket capabilities. Historical metadata-only profile assertions remain usable
without a bucket object. The original unmapped `ASSETS` opener preserves its
existing per-operation capability behavior; explicit mapped entries require the
complete R2 surface.

## Retention, recovery and qualification

Typed File/location holds retain their exact physical addresses. Native S3
addresses are excluded from legacy R2/WebDAV namespace bridges. A migrated
published typed occurrence releases its obsolete legacy physical alias while
unknown or unresolved legacy references remain conservative retention roots.
FP3 source grace, current publication, active read holds and uncertain candidate
writes remain independently protected before physical GC.

Portable recovery retains File identity, original acceptance placement, activation
and role-selection history. Installation keys, credential payloads, local native
bindings and deployment R2 maps remain local. Restore leaves provider execution
disabled until the installation independently qualifies its exact capabilities.

Development qualification lives in:

- `scripts/current-schema-source.test.mjs`: individual Wrangler statement
  execution, complete catalog equality, retained cells/claims/signed rowids,
  appended ledger ordering and rollback on an actual foreign-key violation.
- `worker/storage/native-s3-byte-storage.test.ts`: activation, retained candidate
  credentials, post-sign fences, re-enveloping, audit-head changes, cancellation,
  historical registration replay and typed native hold projection.
- `worker/files/r2-profile-bindings.test.ts`: strict declarations, namespace
  separation, missing bindings and all request lifecycle fences.
- `worker/files/jobs/r2-profile-migration-workerd.test.ts`: native populated D1
  prefix-17 upgrade to 18/19, signed-int64 preservation, full catalog/FK checks,
  two actual local R2 instances, bounded native hashing/FixedLengthStream,
  stable File reads, read holds and unresolved legacy occurrence protection
  through source cleanup and GC.
- Native ingress, Comment, sample record, job, archive and recovery suites own
  their business-publication and paired-portability qualifications.

These isolated development providers establish local runtime behavior. Live
provider acceptance and production rollout remain separate roadmap evidence.
