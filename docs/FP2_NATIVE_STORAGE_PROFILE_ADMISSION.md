# FP2 native AWS S3 profile admission

Status: implementation and review in progress, based on merged and deployed
#246 (`4d7d942`). This slice pairs migration `0017` with V20 content export and
isolated recovery. Final validation and deployment evidence belong to its PR.

An independently authorized administrator can register a qualified AWS S3
identity in the native File storage registry. Registration creates an immutable
profile and portable admission evidence. Its initial `read_only` state does not
provide an S3 File reader: native S3 byte access, accepted writes, lifecycle/GC,
activation and upload-default changes remain a separate complete slice.

## Qualified identity and admission

The initial supported identity is an AWS commercial-partition general-purpose
S3 bucket with a required owner condition. Its canonical physical identity is:

```json
{
  "kind": "aws-s3",
  "partition": "aws",
  "accountId": "<12-digit AWS account ID>",
  "bucketName": "<bucket name>",
  "root": "<object-key prefix>"
}
```

The account, bucket and root identify the namespace. A region, service endpoint
or path-style choice is request configuration, not a second identity for the
same namespace. Generic S3-compatible endpoints, R2, other AWS partitions and
WebDAV cannot acquire this identity by supplying an account number. Existing
bootstrap R2 and historical SWITCHdrive profiles retain their identities.

Registration requires the independent verified-Access administrator policy,
an exact current owner-qualified successful check, an authenticated credential
envelope under the current deployment key, and no running or unresolved check
cleanup for the candidate. The service captures the current configuration and
complete envelope, then rechecks that context atomically before committing the
profile and its admission evidence. A concurrent candidate edit or re-enveloping
operation cannot register a mixture of old evidence and new configuration.
The registration itself performs no provider request. A successful check remains
dated evidence rather than a guarantee of future provider availability.

The registered `storage_profiles` row uses `adapter_type='s3'`,
`configuration_source='system'`, `credential_reference=NULL` and native profile
revision `1`. That native revision does not identify the mutable candidate's
configuration revision. The immutable `storage_profile_admissions` receipt
preserves nonsecret registration provenance; it contains no provider credential,
credential envelope, root key or usable provider-access binding. Candidate
changes cannot reinterpret the registered account, bucket or root.

## Native boundaries and Settings

Database guards keep admitted S3 profiles `read_only`, prohibit S3 File locations
and prevent selecting them as upload defaults. A restored profile has the same
restrictions. These guards protect the boundary even when SQL bypasses the
normal API. Existing R2 and SWITCHdrive behavior, accepted destinations and the
two immutable R2 defaults remain unchanged.

The existing candidate configuration page offers the administrator registration
action and its outcome. Registration is separate from activation; readiness
continues to report `canActivate: false`. No new read-only readiness panel is
introduced. An S3 profile's native registration must not be presented as working
S3 File access, a successful upload or an enabled write destination.

## Paired V20 export and recovery

The native schema changes require a successor archive even when no S3 File
locations exist. V20 preserves the expanded registry and immutable admission
receipts alongside existing content and bytes. Its validator enforces the same
identity/receipt relationships and rejects S3 locations, non-read-only S3 state
or S3 default assignments. V19 and earlier schema fingerprints and readers remain
frozen; the migration must not be hidden by the system-configuration projection.

Ordinary content archives still exclude the installation's `system_*` candidate,
audit, check and credential tables. The new native receipt is distinct from those
protected records: it preserves registration evidence without restoring their
payloads or requiring their rows to exist. A content archive is not an
installation configuration or credential backup.

V20 writer, archive construction, schema negotiation and isolated recovery ship
together. Recovery preserves native profile identity and registration evidence,
performs no provider I/O and reinstates paused File/shadow execution. Historical
V7–V19 recovery can apply the reviewed forward migration without inventing S3
registrations, changing accepted destinations or replaying installation actions.

## Required qualification and following work

Review and qualification must cover:

- Atomic populated migration on native D1, preserving existing rowids, claims,
  foreign keys, capture triggers and accepted history.
- Exact-check admission, owner/namespace conflicts, administrator policy,
  credential unavailability, candidate/envelope races and unresolved cleanup.
- Database rejection of S3 locations, write admission and default selection.
- One relevant paired V20 non-empty export/recovery fixture preserving existing
  bytes together with admitted S3 identity and receipts; malformed or tampered
  relationships and protected payloads must be rejected.
- Frozen historical readers and forward recovery retaining paused execution and
  existing R2/SWITCHdrive data.

Fixture qualification does not establish a live AWS check or privileged live
registration. The existing FP1 HTTP/ZIP acceptance remains evidence and need not
be repeated as an unrelated rehearsal. A fresh live V20 archive check depends on
the deployed capability and available platform permissions; any outstanding live
acceptance is recorded explicitly rather than inferred from fixtures.

Next, implement the complete S3 byte-access and acceptance/lifecycle boundary,
including exact runtime credential/configuration binding, readers, writers,
publication, cleanup/GC and its paired archive/recovery support. Atomic activation
and independent defaults follow that support and real-provider qualification.
The FabuBlox whole-import target limitation must be resolved before independent
roles can send provenance and images to different providers.
