# FP1f: durable FabuBlox import acceptance

Status: implementation after [FP1e](./FP1_RECOVERY_BYTE_VERIFICATION.md).
Development base: `9f1ac38` on `v2/backend-foundation` (merged PR #212),
2026-09-13. This slice gives FabuBlox requests a durable retry identity and a
frozen physical destination. It does not complete FP1 or activate File locations.
The implementation PR records final verification, review and deployment evidence.

## Accepted request and execution ownership

Previously, every POST created fresh import and execution IDs. A lost successful
response, or a failure while opening the completed Template in the browser, could
lead a second confirmation to create another immutable Template version.

The browser now sends a stable UUID in `X-Import-Request-Id` for one confirmed
request. The [acceptance service](../worker/imports/fabublox-acceptance.ts) stores
that identity in the existing `imports` ledger before deduplication or provider
I/O. Its unique key includes the authenticated actor. A UUID belonging to another
actor does not reveal the other actor's operation or result.

The client request ID and the execution's `operation_id` are different identities.
Only the invocation that owns the newly accepted execution may perform its work.
An INSERT race or lost acknowledgement is reconciled against the primary database
before ownership is returned. A retry observes the original operation; it does
not acquire a new lease or replay unfinished provider writes. The existing
finalization and recovery guards continue to own publication and cleanup.

The request snapshot records complete SHA-256, byte size, effective MIME type and
filename for the workbook, normalized manifest and every uploaded image. Image
entries also retain their local IDs. The manifest hash covers its complete parsed
graph, title and selected family. Its bytes use canonical JSON; multipart
boundaries and JSON formatting are not request identity. Duplicate or unexpected
multipart fields are rejected. Workbook/image hashes cover the actual uploaded
bytes, including the browser's prepared image compression.

The snapshot classifies the workbook and manifest as `provenance`, and imported
illustrations as `embedded_content`. This is accepted operation metadata, not
proof that legacy deduplication already enforces independent purpose placement.
The snapshot has schema `fabublox-import-request/1`, contains no byte payloads or
credentials, and is limited to 128 KiB of UTF-8 JSON. A digest of that exact
canonical snapshot binds the request. Existing 50 MiB aggregate payload and
180-step/180-image limits remain in force.

## API outcomes and browser recovery

| Request or observation | Outcome |
| --- | --- |
| First accepted POST completes | 201 with `{id, templateVersionId, version}`. |
| Same actor, request ID and input; original is ready | 200 with the original stored result, without provider I/O. |
| Same actor/request ID, different immutable input | 409; no second import or provider I/O. |
| Original is pending | 409 with `request` state containing the stable request/import IDs and lease expiry. |
| Original failed | 409 with failed `request` state; that operation cannot restart. A new import is an explicit new operation. |
| POST has no request header | 428 requiring the old page to reload. An invalid UUID is 400. |
| Authenticated GET `/api/imports/fabublox/requests/:requestId` | 200 with pending, failed or ready state; 404 when this actor has no recorded request. |
| Acceptance outcome cannot be read authoritatively | 503 with a safe message; the client retains the same identity. |

POST computes and checks the immutable input before replay. It consults the
accepted record before selecting the current family or bootstrap profile. Ready
replay and the read-only status endpoint therefore do not require the current
provider to be available. The stored result does not depend on the Template still
being available for navigation; a later deletion must not turn replay into a new
import.

The browser prepares compression once and keeps that exact FormData for an
in-page retry. It saves the UUID and title in session storage before sending the
POST; unavailable session storage prevents submission. Workbook/image bytes are
not persisted in browser storage. Input controls remain fixed for the submitted
operation. A failure opening a completed Template preserves its successful result
and offers another attempt to open it, without submitting another import.

A 404 status check is only a point-in-time absence: an earlier POST may still be
validating before its acceptance INSERT. The browser retains the same request ID.
It can retry the cached payload, or after reload reselect and prepare the input
under the saved ID. Changed input will conflict if the original operation has
already been accepted. A 404 does not establish cancellation or authorize a
replacement identity. Pending/unknown operations remain available for status
checks; failed/completed operations can be followed by an explicitly new import.

The checkpoint belongs to the browser session and contains no resumable byte
stream. Closing the session, clearing storage or deliberately submitting a new
UUID is outside same-request replay protection. This is not a global guarantee
against two distinct operations intentionally creating two versions. There is no
new server cancellation API or byte-level resumability. Existing 24-hour import
leases and scheduled recovery remain responsible for abandoned executions;
checking status does not execute their recovery or change the Cron schedule.

## Frozen R2 namespace and deployment composition

New accepted imports record an immutable R2 profile ID, configuration revision 1,
policy revision 1 and `system` scope. The first use captures a historical bootstrap
profile with the actual physical account/bucket namespace. Profile creation
reconciles races and unknown database responses without rewriting an earlier
capture. Existing File and Location state restrictions remain unchanged.

The generated remote configuration obtains the account from Wrangler's existing
standard `CLOUDFLARE_ACCOUNT_ID` or `CF_ACCOUNT_ID` environment, in that order.
Otherwise it uses the installed `wrangler whoami --json` only when the existing
credentials report exactly one account. Invalid explicit values, missing identity
or ambiguous accounts fail instead of guessing. The already configured
`DEPLOY_R2_BUCKET_NAME` supplies the bucket. The same account is pinned in
`account_id` and the canonical runtime `R2_BOOTSTRAP_NAMESPACE`; a deployment check
compares the built Worker and migration configuration identities.

The generator does not log in, extract credentials, hard-code an account or
provision/rebind storage. A binding label, D1 UUID or Worker hostname is not used
as physical namespace evidence. Local development uses a separate persisted
installation UUID and bucket identity which cannot alias a Cloudflare account.

New acceptance fails safely when an existing captured namespace and the runtime
namespace do not agree. A namespace change is not credential rotation and must
not silently reinterpret old keys. Independently invoked recovery also checks an
accepted import's recorded profile before reading its R2 bytes. A mismatch leaves
the operation for explicit resolution; it cannot inspect another bucket and
certify or release the old operation there. Legacy imports with no accepted
profile keep their historical recovery contract until the full File conversion.

## Forward schema and archive compatibility

[Migration 0003](../migrations/0003_fp1_import_acceptance.sql) adds eight nullable
columns to `imports`: `client_request_id`, `request_sha256`, `request_input_json`,
`request_scope`, `storage_profile_id`, `storage_profile_revision`,
`storage_policy_revision` and `accepted_result_json`. Existing rows retain NULLs;
the migration does not invent historical request identities or verification.

New acceptance fields must be complete together and are immutable, including the
actor and execution ID. Database guards prevent replacement/deletion of accepted
identities, including SQLite replacement with recursive triggers disabled. Failed
accepted operations cannot return to pending. Publication stores the exact
`{id, templateVersionId, version}` result in the same guarded UPDATE that marks
the import ready; the result must match that import and its Template version at
publication and is thereafter immutable. No parallel acceptance state machine
needs a separate successful commit.

Current full export uses archive schema **10**, writer **1**, profile
`fp1-import-acceptance`. The exact catalog and snapshot include the acceptance
columns and frozen profile state. V7/V8/V9 validators remain specific to their
historical formats; old archives are restored against their reviewed schemas
before applying the forward migration chain. Recovery preserves accepted history
and results, without inventing acceptance for legacy rows or automatically
replaying historical execution/cleanup operations. Old export pages must reload
instead of silently omitting the new authority fields.

Rollback cannot rely on deploying an old binary once new accepted records exist:
that binary cannot enforce or export the new protocol. Use the reviewed
backup/isolated-restore and forward-deployment procedure. No reset, live-byte
migration, storage rebinding, credential rotation or Cron change is part of FP1f.

## Qualification and remaining File authority work

Qualification covers populated forward migration and rollback, immutable identity
and result guards, actor isolation, duplicate/racing requests, lost database and
HTTP acknowledgements, altered workbook/manifest/image inputs, namespace mismatch,
client checkpoint recovery and navigation failure after successful publication.
The native fixtures exercise local workerd with real D1/R2; archive qualification
covers schema 10 and historical restore-then-upgrade behavior. These are test
scopes; the PR records which checks passed and the exact reviewed/deployed head.
No live provider or browser result is certified by this document alone.

ZIP-specific and browser ZIP acceptance remain deferred at the owner's request.
Mandatory existing archive/restore regressions remain part of normal verification.

The [FP1d consumer inventory](./FP1_FENCED_BYTE_DELETION.md#next-authority-transition-complete-inventory)
and [whole-transition gates](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md#schema-and-api-transition-strategy)
still apply. `files` and `file_locations` remain unresolved, without verified hashes
or active pointers; the four FP1a table definitions and their immutability guards
are preserved. Legacy assets/managed records and retention still own bytes, and
global-SHA legacy deduplication remains. Other upload boundaries do not gain the
FabuBlox request protocol automatically.

Complete File activation still requires typed consumer foreign keys, classification
and independent verified copies for incompatible purposes, purpose/scope/profile
deduplication, complete retention/quarantine/location deletion fencing, stable
authorized resolution and matching export/recovery. Purpose-aware accepted File
operations must cover every writer. Only after that conversion do R2 defaults for
new originals and authenticated storage Settings close the remaining FP1 scope.
