# FP2 bounded candidate storage checks

Status: merged and deployed in #242 (`cf64d15`) on 2026-10-02 as Worker
`015b3540-1c17-4b0f-b2cb-0ca5dfe276a9`, Cloudflare build
`227c5a0b-dba7-4d80-bda8-d142f8268b2b`. No live privileged provider check is qualified yet. This slice adds
administrator-triggered S3 checks to the deployed
[configuration foundation](./FP2_CONFIGURATION_SECURITY_FOUNDATION.md).
It does not activate a provider, select role defaults or register an accepted File
operation. WebDAV qualification remains later.

## Accepted check and provider work

A check accepts a UUID `checkId`, `profileId` and `expectedRevision`. Before any
provider request, one transaction captures the exact candidate revision,
credential reference, encrypted envelope and envelope revision, immutable
namespace and its digest, configuration digest, unique probe key, expected
payload hash/size, actor and creation time. Latest-candidate and envelope
comparisons reject stale acceptance. Credential plaintext stays in memory;
browser responses expose safe outcomes only.

The probe writes one random 1,024-byte payload under a unique
`__fp2_checks/<checkId>/<uuid>` key. It verifies the complete readback SHA-256 and
size, checks provider metadata, deletes that exact object and confirms absence
with HEAD. Each outcome is recorded separately. A successful check requires all
four stages to pass and cleanup to be `confirmed_absent`.

The same check ID with the same canonical profile/revision returns its stored
status; it never writes the probe again. Conflicting reuse is rejected. A new
candidate revision receives no inherited result, and later candidate editing or
credential rotation does not alter an accepted check's captured context.

## Lost responses, interruption and cleanup

GET status reconciles an expired execution lease as interrupted. It does not
resume or repeat provider work. The browser retains the check ID so a lost start
response can be reconciled by status rather than another PUT.

Cleanup has its own fenced execution token and deadline. Manual cleanup uses only
the recorded key and original captured provider/credential context. It can DELETE
and confirm absence; it cannot replay a write or turn failed verification into a
successful check. An unavailable retained encryption key leaves cleanup required
and preserves both the protected snapshot and the original check result code.

An interrupted or uncertain PUT retains an unknown write outcome. A later DELETE
and missing HEAD response establishes `absence_observed`, not `confirmed_absent`:
an earlier remote write may still complete. This uncertainty remains visible and
does not become successful qualification. A stale execution token cannot publish
success after its lease expires or a cleanup attempt takes ownership.

One profile has at most one running check or cleanup. A terminal uncertain check
does not block a new independent test with a different ID/key; its unresolved
cleanup remains visible. The browser stores only the check ID/profile/revision
intent in session storage. A lost response followed by GET 404 remains unresolved
and does not authorize replaying the original write.

## Safe result contract

Administrator result objects contain the check ID, profile ID, revision, overall
status, stage outcomes, cleanup outcome, safe code and timestamps. They contain
no probe key, physical address, credentials, encrypted payload or provider error
text.

| Field | Values |
| --- | --- |
| `status` | `running`, `succeeded`, `failed`, `interrupted` |
| `write`, `read`, `metadata`, `delete` | `pending`, `passed`, `failed`, `unknown`, `not_run` |
| `cleanup` | `pending`, `running`, `required`, `confirmed_absent`, `absence_observed` |
| `code` | `credential_unavailable`, `provider_unavailable`, `read_verification_failed`, `metadata_verification_failed`, `cleanup_unconfirmed`, `execution_interrupted`, or `null` |

Checks and cleanup retain the independent verified-Access system-administrator
boundary and private/no-store responses. General application or File evidence
operator access does not grant this permission. Candidate administration remains
separately available while recovered File execution is paused; that does not
resume ordinary File operations.

Routes are under `/api/storage/configuration`:

| Method and path | Request and behavior |
| --- | --- |
| `POST /checks` | `{ checkId, profileId, expectedRevision }`; accept once or return the existing result |
| `GET /checks?profileId=…` | Bounded history of up to 50 safe results |
| `GET /checks/:checkId` | Reconcile and read one durable result |
| `POST /checks/:checkId/cleanup` | `{}`; attempt cleanup against the recorded context only |

The [candidate check evidence report](./FP2_CANDIDATE_READINESS.md), merged and
deployed in #245 (`5992307`), adds a separate read-only
GET for a selected candidate revision.
It counts all retained history and identifies the latest success matching the
complete current configuration and credential envelope. It performs no lease
reconciliation, database writes or provider calls. A previous envelope's success
remains historical evidence after re-enveloping; neither historical nor exact
matching evidence is a current connectivity guarantee or activation permission.

Write requests have a 4 KiB body limit and use the existing authenticated
cross-origin boundary. These routes do not change saved candidate credentials.

## Persistence and content recovery

Migration `0015_fp2_storage_candidate_checks.sql` adds installation-only state:

| Table | Purpose | Ordinary content export |
| --- | --- | --- |
| `system_storage_candidate_checks` | Exact protected check context, fenced execution and safe outcomes | Excluded |
| `system_storage_candidate_check_audit` | Append-only actor, operation and safe outcome history | Excluded |

Audit rows do not copy protected context, probe keys or provider addresses.
The encrypted snapshot in a check row is protected installation material, just
like the configuration credential payloads. Key retention must include these
snapshots when cleanup may still be needed.

V19 stays frozen. With [credential re-enveloping](./FP2_CREDENTIAL_REENVELOPING.md),
content schema projection excludes exactly eight system tables and their owned
schema objects: these two, the five configuration tables and the re-enveloping
receipt table. Unknown application objects remain subject to the existing fingerprint. Isolated V7–V19
content recovery skips the exact installation-only `0014`, `0015` and `0016` migrations,
restores neither credentials nor checks and keeps execution paused. A content ZIP
is not an installation configuration or credential backup.

## Qualification boundary and following work

The current live account shows the read-only administrator boundary. Privileged
candidate editing, real S3 checks and manual provider cleanup remain unqualified
until exercised with the deployment-managed administrator policy and Secret.
Read-only status does not reveal whether a keyring is installed. Actual credential
values and administrator addresses stay outside Git and issue reports.

FP1's accepted 6 MiB HTTP round trip and V19 isolated recovery remain evidence;
this slice does not require repeating the same upload or ZIP acceptance.
Local qualification and independent review passed on 2026-10-02:

| Qualification | Passing tests |
| --- | ---: |
| Contract, SQL constraints, populated-system V19 export/recovery | 12 |
| Service faults, deadlines, corruption and historical-context cleanup | 18 |
| HTTP authorization/input boundaries and native Worker/D1 integration | 5 |
| Client and mounted UI, including response loss and privilege revocation | 23 |
| Current schema chain and native D1 migration observation | 13 |

The native integration uses Worker AES-GCM/DigestStream and real D1, with an
in-memory S3 fixture. It confirms active-profile conflict returns 409, two
independent checks perform only two PUTs, and cleanup retains the original
credential/region after a candidate edit. TypeScript and the production-artifact
build also passed. All required repository checks and both merge CI jobs passed, and the Cloudflare
build succeeded. The live configuration page displayed the S3-testing description
and expected read-only administrator view; Storage Settings retained R2 for both
roles. Fixture qualification does not replace real-provider acceptance.

The [S3 bucket-owner condition](./FP2_S3_BUCKET_OWNER_CONDITION.md) is being
implemented and reviewed as the next qualification prerequisite. An optional
AWS owner condition is captured with each full configuration and signed on all
four object operations; accepted check cleanup retains its captured condition.
It introduces no migration or activation and makes no generic S3 identity claim.

Activation remains a separate slice. It must establish actual provider account
and namespace identity before native profile admission; a passed probe is not
permission to reinterpret an activated namespace. Independent role defaults
also require all accepted ingestion paths to select and retain their exact
purpose/profile/revision. The shared selection boundary is deployed in #244;
native admission, mutable defaults and paired successor archive/recovery support
remain later work. These checks change neither default today.
