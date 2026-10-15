# FP3 current background actor admission

Status: bounded implementation and focused local regression qualified on
2026-10-10 at 12:45 UTC. Exact combined-tree/default CI qualification remains
the integration checkpoint's separate gate.

The proposed FP2–FP5 development integration exposed an introduced admission
gap in `worker/files/jobs/worker-runtime.ts`. Its background migration actor
predicate checked `AUTH_MODE=access` and `SYSTEM_ADMIN_EMAILS`, but did not
recheck the ordinary application's Access configuration or `ALLOWED_EMAILS`.
A previously accepted job could therefore continue after its actor lost
application admission while retaining an administrator allowlist entry.
Research package and system recovery executors already require both policies.

The File migration predicate now also requires the configured Access team and
audience and calls the existing `allowedEmail` helper. The kernel's existing
claim, request and publication fences evaluate the current environment through
this predicate; no old JWT becomes a background execution credential. Case
normalization and the ordinary empty application allowlist behavior remain the
same as HTTP authentication. `AUTH_MODE=disabled` still grants no File migration
administrator admission. Separately granted installation cleanup remains
independent of the original migration actor's later revocation.

The existing native migration and V22 archive fixtures now supply Access
metadata and their admitted actor. The recovered-asset test supplies that
metadata only for its explicit Access-authenticated migration handoff; its
ordinary disabled-authentication read fixture is retained. All worker runtime
factory/dispatcher test callers were inspected for this admission requirement.
The shared storage upload fixture is unchanged, and no
production admission, schema, historical archive contract, provider transport,
lease budget or test deadline is weakened.

## Reproduction and verification

Source baseline before the runtime fix:
`4b2c660267b794d09798f961efe8d11ba6e1df86`.

| Check | Result |
| --- | --- |
| Pre-fix `npx vitest run worker/files/jobs/worker-runtime-authorization.test.ts --maxWorkers=1` | **RED:** 1 file; 6 failed, 4 passed, 10 total; 4.02 seconds |
| Fixed `npx vitest run worker/files/jobs/worker-runtime-authorization.test.ts worker/files/jobs/native-migration.test.ts --maxWorkers=1` | **PASS:** 2 files; 16 passed; 15.44 seconds |
| `npx vitest run worker/export-v22-protocol.test.ts worker/recovery/recovered-asset-read.test.ts --maxWorkers=1 -t 'preserves verified migration\|keeps the NULL-SHA URL usable'` | **PASS:** 2 files; 2 passed, 25 skipped, 27 total; 24.54 seconds |
| `git diff --check` | PASS |

The six red cases are current application allowlist removal, missing Access
team, missing Access audience, two already accepted job executions after
application/configuration revocation, and application revocation after a job
claim. The old predicate returned true in the first three cases; the executor
claimed the revoked queued jobs and reached the provider witness rather than
rejecting their actor. Post-claim revocation produced a generic storage failure
at the witness instead of the expected `execution_not_authorized` pause.

The new ten-case suite constructs the actual worker capabilities and uses the
real SQL repository and migration kernel on isolated physical copies of the
actual schema through `0019`. Test-only publication seeding restores the real
immutable migration guards before acceptance and execution. It observes
`administrator_revoked` before claims or `execution_not_authorized` after a
claim, zero provider calls, zero pre-claim candidate attempts, unchanged active
File locations, and no foreign key violations. The native six-case regression
retains the existing S3/R2 transport and independent job behavior.
The two selected archive/recovery regressions preserve actual V22 migration
provenance/restore isolation and recovered NULL-SHA asset reads after a real
fixture R2-to-S3 migration and garbage collection. The other 25 cases in those
files were deliberately skipped by this focused command; it is not a full
archive/recovery suite result.

The provider witness in the new authorization suite rejects any admitted
object request. No live provider, external request, remote database migration,
replay or production deployment was performed. Focused host/native fixture
qualification does not establish real-provider or deployed Access acceptance.

## Qualified source file receipts

| File | SHA-256 |
| --- | --- |
| `worker/files/jobs/worker-runtime.ts` | `e4f4648117e288463dfcec6d33c43cff27d6eaab20a3061248ac9faad0338f09` |
| `worker/files/jobs/worker-runtime-authorization.test.ts` | `ae4275fe2800035909d84e9b5b8860301a7e007d984bae3fae8d6ee9b5c02a6f` |
| `worker/files/jobs/native-migration.test.ts` | `c048e2eda3350cb4a4fe05a846fa3ca00b5fecdf36559a7f2f23870779a4f437` |
| `worker/export-v22-protocol.test.ts` | `262dd169a0ff135494d2efe67df66419b4367e29e7b3ee077506f52e0b85c099` |
| `worker/recovery/recovered-asset-read.test.ts` | `0651d34ffb566b6851a5db0fa2a2e934299759228ee6c6b3994a4895452b8f04` |

Transient detailed logs were `/tmp/fp3-job-authorization-before.log` and
`/tmp/fp3-job-authorization-after.log`, followed by
`/tmp/fp3-job-authorization-archive-recovery.log`; their result summaries are retained here
because environment publication can remove temporary artifacts.
