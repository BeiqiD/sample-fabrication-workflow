# FP1d: provider-neutral deletion and fenced GC recovery

Status: bounded FP1 implementation after [FP1c](./FP1_VERIFIED_BYTE_WRITES.md).
Development base: `35664cb76c75ba4b99b07b26759cdbe6d661e163` on
`v2/backend-foundation`, 2026-09-13. Executed verification and deployment evidence
belongs to the implementation PR; this document does not certify a deployment.

This completes the transport seams for the two existing storage paths. It does
not activate the [FP1a registry](./FP1_FILE_REGISTRY_FOUNDATION.md), replace legacy
retention authority or complete FP1.

## Delivered boundary

[`ByteDeleter`](../worker/files/byte-deleter.ts) deletes an opaque key from one
already-bound storage instance. Its adapters report acknowledged completion,
denial or an unavailable/uncertain result without forwarding provider exception
text. They do not choose defaults, grant deletion authority, modify SQL, retry a
request or switch providers. The runtime bridge validates the legacy provider
identity before supplying the R2 or managed instance.

The legacy ledger still records store kind/provider/key rather than a persisted
profile namespace. Runtime composition binds one supplied instance; safe retries
continue to require unchanged physical R2 bindings and managed account/root.
This slice does not make manual namespace rebinding safe or pin a provider
version. Persisted profile identity and configuration transitions belong to the
complete File-authority conversion below.

`collectBlobGarbage` receives explicit persistence, storage, time and
operation-identity capabilities. The `runBlobGarbageCollection` runtime wrapper
retains the existing scheduled entry point.
Provider I/O remains outside the database transaction and follows a successful
guarded deletion claim. The shared `blob_retention_edges` view, registration
grace, orphan grace and bounded discovery/deletion work remain authoritative.

An acknowledged DELETE follows the existing adapter completion contract. R2
resolves its delete operation; SWITCHdrive accepts its existing checked
200/204/404 responses, with 404 representing idempotent absence. This is not a
generic claim that every future provider's acknowledgement proves physical
absence. An adapter that merely accepts asynchronous work cannot return this
completion result without a qualified completion check. No extra stat is required
after an initially acknowledged deletion in this slice.

## Uncertain deletion remains claimed

A provider exception may follow a completed DELETE or a request still in flight.
Returning that locator to `orphaned` would let reuse or a new retention edge
revive it while the old request could still remove its bytes. A failed or unknown
delete therefore stays `deleting`, with a fixed redacted error and its stable
operation ID. Authentication/configuration failure also leaves that protection
in place. A provider failure does not create an integrity-quarantine diagnosis.

After the existing claim lease expires, a successful guarded reclaim increments
the attempt count. That attempt checks the exact instance/key before any repeat
DELETE:

| Observation | Action |
| --- | --- |
| Confirmed missing | Finalize the matching claim without another DELETE. |
| Available | Repeat the idempotent DELETE for the same claimed key. |
| Denied or unavailable | Record a redacted failure and retain `deleting`. |

There is no fallback destination and no restoration of the old key to live
status. A terminal `deleted` locator remains terminal even if bytes are later
recreated externally. Recovery must use a new locator.

## Execution fencing and database acknowledgement

The stable operation ID identifies cleanup of the locator; each attempt is
additionally identified by its incremented `attempt_count` and
`deletion_started_at`. These values come from the guarded claim/reclaim, not an
unprotected later lookup. The count distinguishes attempts even when two runs
use the same timestamp.

Finalization and error recording compare the exact attempt. A stale FP1d executor
cannot finalize a renewed claim, reset its state or overwrite its diagnostics.
Managed-object `deleted` status and the matching ledger finalization stay in one
atomic database batch. Failed or uncertain database acknowledgement does not
release the claimed locator. A later guarded attempt reconciles provider state
and converges without admitting a new reference in between.

Fixed diagnostics describe the failing operation without persisting exception
messages, response bodies, endpoints, object paths or credentials. Existing
historical `last_error` values are not rewritten by this change.

### Rollout and old executors

These fences apply to executors running FP1d or later compatible code. An older
binary still uses operation-ID-only updates and may return a failed delete to
`orphaned`; it cannot be made safe by the new executor's checks alone. Old
maintenance executions must drain before the new guarantees can be treated as
fully active. Reintroducing the older binary reintroduces that behavior, even
though schema 9 / writer 1 remains readable by both versions.

The repository's only production caller is the scheduled maintenance handler,
with a declared daily schedule of `03:17 UTC`. This slice adds no HTTP/manual GC
trigger and does not invoke remote GC during acceptance. GitHub deployment
success and ordinary browser checks do not establish that an older maintenance
execution has drained or that remote trigger/hold settings match the repository;
cross-version execution safety is not claimed by those checks.

## Unchanged authority and operational limits

There is no SQL migration or archive-protocol change: schema 9 / writer 1 /
`fp1-legacy-overlap` remains in force. File/Profile observations stay immutable,
unresolved and dormant. This slice does not add active File locations, accepted
upload operations, profile/default selection, migration/read/export holds,
credential configuration, a new cleanup endpoint or a durable job runner.

The 24-hour registration grace, seven-day orphan grace, 15-minute deletion claim
lease and 100-candidate deletion batch are unchanged. Retry occurs through the
existing maintenance entry point after eligibility; this does not introduce an
executor heartbeat, per-provider backoff or a promise of cleanup within 15
minutes. Existing pending-write/import ownership remains governed by the
[lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md).

No Cron/Builds control, storage binding/default, credential, live file migration
or remote cleanup is changed as part of verification. The existing operational
holds and remaining live acceptance stay owned by the
[S2 checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md). Synthetic browser data
may use ordinary recoverable deletion; it is not a remote GC acceptance test.
ZIP-specific and browser ZIP tests are deferred at the owner's request. Required
regression gates remain in place; no archive round trip is claimed here.

## Qualification requirements

The implementation PR must record the executed results for:

- both adapters, invalid provider combinations, fixed error results and disposal
  of unused managed responses;
- a completed DELETE with a lost response, a still-present object on retry, and
  denied/unavailable reconciliation without releasing the locator;
- attempted new references and reuse while deletion remains uncertain;
- stale success/failure after reclaim, including overlapping attempts with the
  same timestamp and managed status consistency;
- database response loss and rollback, retained-source races, existing grace
  periods, bounded work and pending-import ownership;
- actual local R2 deletion followed by missing reads/stat, plus real D1 and host
  SQLite claim/reclaim/finalization behavior;
- the ordinary full verification graph, independent review, deployment status
  and applicable browser regression acceptance.

Native local R2 and deterministic managed fixtures do not establish working live
SWITCHdrive credentials or remote deletion acceptance. Executed counts, PR and
deployed version are recorded only after those checks complete.

## Next authority transition: complete inventory

The next File authority transition must convert the following groups together.
This is the concrete handoff inventory, not permission to activate a subset of
Files while the remaining sources still use unrelated retention rules.

| Group | Current authoritative surfaces and required conversion |
| --- | --- |
| Relational image/evidence roots | `state_representation_assets`, `run_step_assets`, `metrology_template_references`, `run_step_comments`, `state_verifications`; preserve ordered content, supersession and each occurrence's restore/grace rules. |
| Canonical Comments | `comment_submission_items` with both R2 and managed locators; preserve item kind, original/preview reciprocity, retry state, common targets and retained history. |
| Direct keys and provenance | `events.asset_key`, `events.metadata_json.thumbnailKey`, import workbook/manifest keys, Template source keys; include direct-only locators without an asset row. |
| Project content and derivatives | `project_content_attachments` and `attachment_derivatives`; preserve Project identity/geometry, copy authorization and trusted derivation separately from byte equality. |
| Registration and lifecycle | `blob-lifecycle/registration.ts`, `reuse.ts`, `reachability.ts`, `gc.ts`, quarantine and all relationship/uniqueness triggers; replace dedup placement and deletion guards together. |
| Import recovery | `fabublox-recovery-assets.ts`, `fabublox-import-recovery.ts`, import routes and publication helpers; retain owning-import visibility, canonical winners and failed/private ownership transfer. Current independently invoked recovery is not fully certified by FP1c ingestion checks. |
| Read/source consistency | Sample directory, `sample-split-state.ts`, execution/metrology/Template routes, Comment/Project serializers, Reference adapters/search and media routes; location changes must not alter research content hashes or hide real source changes. |
| API and frontend | Comment managed-storage capability, Project asset/object locator union, Sample export keys, previews and downloads; supply an explicit tested compatibility bridge or negotiated stale-client rejection. |
| Export and restore | `export-catalog.ts`, `export-v8-snapshot.ts`, the blob planner and isolated restore; preserve new authoritative state and every byte root, including historical, failed, quarantine and GC records. |

Before relaxing the FP1a unresolved-state guards, establish accepted operation
identity and immutable input, purpose/scope, resolved profile and policy revision;
retry must resolve that operation before consulting changed defaults or dedup
candidates. Guarded File publication needs verified bytes, exact profile/location
ownership and matching recovery coverage. Cross-purpose/shared legacy keys need
explicit classification and independently verified placements where necessary;
unavailable bytes remain unresolved. Populated upgrade and reachability fixtures
must cover all groups above.

Only after that complete conversion should FP1 enable the explicit R2 policy for
new originals, role-specific readiness and basic authenticated Settings. Existing
originals retain their recorded location. FP2's configuration/secrets/S3 work and
FP3's migration/job holds remain separate gates in the
[implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md).
