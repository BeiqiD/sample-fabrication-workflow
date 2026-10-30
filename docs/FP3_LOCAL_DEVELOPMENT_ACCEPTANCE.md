# FP2 and FP3 local development checkpoint

Status: local development goal through FP3 complete; required checks qualified.
Formal real-provider and deployed-runtime acceptance remains pending.
Date: 2026-10-05 (UTC). Integration base: `v2/backend-foundation` at `474a038`.
Development branch: `codex/fp2-fp3-development`.

This checkpoint implements the owner's development goal through FP3. The
[product roadmap](./PRODUCT_ROADMAP.md) and
[portability implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md)
retain their acceptance conditions. No deployment, remote migration, production
file transfer or live-provider activation is included.

## Delivered behavior

Migration `0018` supplies exact-instance native R2/S3 File access, verified
publication, retention and GC, candidate activation, and independent internal
and original-file defaults. Ordinary images, metrology references, Comment
images/originals/previews, Sample records, Project attachments and FabuBlox
imports retain their accepted targets and business identities. New native media
uses `/api/file-assets/:assetId`; historical opaque R2 URLs retain their meaning.
Settings explicitly requests its current V3 read model; the legacy V2 endpoint
and historical acceptance generations remain supported.

Migration `0019` supplies persisted migration jobs, per-File candidate attempts,
independent bounded execution, progress, pause/resume/cancel/retry, read holds and
separately requested cleanup. The administrator interface is
`/settings/storage/migrations`. HTTP handlers accept and control work; execution
continues through independent invocations. Each destination is registered before
PUT, source and destination receive complete SHA-256 verification, and cutover
checks the current File pointer and executor ownership atomically.

Plans accept at most 100 Files, 100 MiB per File and five candidate attempts per
File per job. The staging budget covers that job; unknown candidates from older
jobs remain held until explicit reconciliation and cleanup. One invocation
processes at most one migration File or one cleanup action
within a 60-second execution budget; cleanup takes priority. Claims last 15
minutes, and source cleanup has a separate 15-minute hold-release grace period.
Physical GC separately requires 24 hours since location registration and seven
days after orphan marking, as well as satisfied retention and provider checks.
Hash writes are bounded to 64 KiB. Resume reconciles the existing candidate;
explicit retry may allocate a new unique candidate. Uncertain writes retain
their holds. Cancellation preserves written artifacts until separately approved
cleanup. Cleanup of written obsolete copies remains pending until physical GC
acknowledges deletion; never-written registrations need no provider DELETE.

The matched content archive generations are V21 (`fp2-native-file-runtime`) and
V22 (`fp3-file-migrations`), both writer 1. Frozen V7–V20 readers remain intact.
Successor archives validate their complete retention graph at one captured source
clock before reading bytes, preserve canonical identities and job history, and
exclude installation credentials, native bindings, runtime guards and cleanup
grants. Offline restore performs no provider requests and creates disabled local
execution guards. Global enablement pauses old queued/running jobs; each job
needs explicit resume, and old cleanup approvals need a new current-incarnation
request. Copy steps recheck their original administrator; separately accepted
maintenance uses the installation's independent cleanup authorization.

## Local qualification

- Actual native D1 upgrade from populated `0017` through `0018`/`0019` preserves
  every original cell, storage type and physical rowid, including signed 64-bit
  rowids and pending legacy receipts; foreign keys and integrity checks pass.
- Real adapters against isolated provider fixtures exercise distinct S3 instances,
  R2 to S3 and S3 to R2, frozen accepted targets, corrupt readback, explicit retry,
  unchanged historical URLs/receipts, held-source cleanup and Comment finalization
  after attachment migration: 6/6 pass.
- Actual native workerd/D1 also migrates an 8 MiB File between two separate local
  R2 buckets, preserves an in-flight source read, retains an unresolved historical
  reference, then permits old-source deletion after guarded resolution: 1/1 pass,
  21.14 seconds for the case (23.17 seconds including harness setup). The same
  fixture proves the populated upgrade and catalog parity.
- Native workerd verifies the maximum supported 100 MiB R2-to-signed-S3 File
  with DigestStream, FixedLengthStream, 64 KiB hash writes, independent destination
  hashing and corruption rejection: 1/1 pass, 11.68 seconds within the unchanged
  60-second test limit. The preceding 16 MiB spike passed before implementation.
- Independent Node processes use one file-backed SQLite ledger, preserve File
  identities and progress, require explicit resume after enabling, and refuse
  the next job after administrator revocation.
- Kernel and archive fixtures cover all five File purposes, late owners, lost
  acknowledgements, retry bounds, cancellation, cleanup, expired read history,
  disabled restored work and empty restored cleanup grants.
  Published read streams are limited to two minutes; their durable holds last
  15 minutes and are released on EOF or cancellation.
- Successor retention validation and native-byte offline recovery give the same
  result under UTC, Asia/Shanghai and America/Los_Angeles, including SQLite
  timestamps without explicit offsets. Historical validators remain unchanged.
- The actual development database has all 19 migrations; all 86 original
  application tables retain their cells/types/rowids, the original 17 ledger rows
  remain intact, and the separate main database retains its exact file hash.
  Foreign keys and integrity pass; execution remains disabled and cleanup grants
  are empty. The pre-upgrade SQLite backup is retained locally.

The canonical `VERIFY_PUBLISH_STATUSES=0 npm run verify:ci` run recorded 11/12
successful leaves in `/tmp/fp3-full-ci-final.log` and
`/tmp/fp3-ci-summary-final.md`: native scripts 349/349, source 2,780/2,780 and
mounted UI 654/654; rich-text, both contract checks, all 19 native D1 migrations,
both reference Worker checks, build and Map bundle also passed. The final Project
artifact leaf used an obsolete V20 request. Updating it to the current V22
exposed a real D1 compound-SELECT limit in the combined retention snapshot.
Original failure logs remain retained.

The final snapshot materializes each exact per-edge stream and joins through a
seven-row selector, using indexed equality on unique view names. It keeps the
single SQL source clock, duplicate multiplicity, empty-view behavior and small
per-edge values; there are no row caps or schema/fingerprint changes. Native
D1 accepts it, and 15/15 retention regressions pass in
`/tmp/fp3-retention-selector-focused.log`. Host SQLite measurements for
6,001/12,001/24,001 output rows are 51/103/226 ms, with automatic covering indexes;
these are local query measurements, not deployed resource qualification.

A fresh `npm run build` and `npm run verify:project-worker-artifact` both pass
in `/tmp/fp3-retention-selector-native-build.log` and
`/tmp/fp3-retention-selector-native-artifact.log`. The actual production artifact
returns HTTP 200 for V22, and its API, assets, Access rejection, 201-reference
inventory, attachment, conflict and lifecycle checks pass. The final six-file
V21/V22/native ingress and affected Project/reference/lifecycle route block passes
66/66 in `/tmp/fp3-final-affected-export-routes.log`. Final export-contract
typechecking, Map bundle checking and `git diff --check` also pass.

All 12 required categories therefore have passing evidence; the repaired last
leaf and affected regressions ran separately after the canonical 11/12 run.
There was no single clean monolithic rerun. Assertion and timeout limits were
preserved. The local preview uses port 3000 with 19 migrations; execution is
disabled and cleanup grants remain empty. `AUTH_MODE=disabled` supports local
ordinary development reads but does not grant administrator migration controls;
the protected executor endpoint correctly denies it with HTTP 403.
Final preview responses and the post-preview 86-table preservation check are
recorded in `/tmp/fp3-final-local-preview.json` and
`/tmp/fp3-final-development-db-qualification.json`; the latter also verifies the
unchanged main database hash, preserved migration ledger, integrity, disabled
execution and empty cleanup grants.

## Acceptance still requiring external resources

The local fixtures establish implementation and runtime mechanics. FP2/FP3
formal acceptance still requires separately authorized real R2/S3 instances,
provider interruption behavior, and the chosen deployed Workers plan's CPU,
memory, elapsed-time and scheduler measurements. The proposed two-minute cadence
has not been installed; the existing daily Cron remains unchanged. SWITCHdrive
live cases remain pending without working credentials. Supported Node provider
transports, filesystem policy and Docker packaging belong to the later runtime
portability milestone, as recorded in the
[capability matrix](./FP3_CAPABILITY_MATRIX.md).

FP4 native research packages with matching website import and FP5 privileged
system recovery remain the next roadmap milestones. Current offline full-export
recovery is maintained here; it does not deliver those later product workflows.
