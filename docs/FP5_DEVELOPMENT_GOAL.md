# Development goal: complete the roadmap through FP5

Status: complete — implementation and local development qualification, 2026-10-06 (UTC). Owner direction received on 2026-10-06 (Europe/Berlin).
Working branch: `codex/fp2-fp3-development`; integration base: `474a038`.
The completed FP2–FP4 implementation and qualification remain preserved.

## Scope and authority

Continue independently through the FP5 exit in the
[canonical roadmap](./PRODUCT_ROADMAP.md) and
[portability implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md):
shared bounded full-backup archives, visible completeness, privileged website
recovery into a fresh target, verified assisted cutover, protected configuration
recovery, and a qualified historical archive conversion/offline recovery path.

The owner has authorized continuous implementation, self-review and appropriate
automated qualification until this development milestone is complete, with minimal
intervention. Work stays in the development environment. Local reversible schema
upgrades and isolated native runtime/provider fixtures are within scope. Production
deployment, remote production migration, actual provider activation, production
file movement, repository push and external messaging remain outside scope.
Concentrated manual and real-provider/deployed-runtime acceptance remain explicit.

Restore preserves canonical business/File identities and recoverable history;
research copy-import retains its separate fresh-identity semantics. Archive SQL is
evidence only. Physical recovery writes use an isolated target and fresh prefix,
including when source and destination share a bucket. Source records and bytes
remain usable until the explicit assisted handoff. Restored operational history
does not authorize automatic execution, deletion or external integration.

Cloudflare target provisioning and binding activation remain deployment-control
operations. The website stages, verifies and prepares a reviewed handoff to an
explicitly provisioned fresh target; it does not manage account-wide credentials.
Historical recovery displays its recovery point and requires acknowledgement of
later-change loss. Any supported no-loss planned cutover additionally requires a
source maintenance fence, reconciled writers and an unchanged final checkpoint.

Preserve the frozen V7–V23 readers, all 20 existing migrations, authorization,
purpose/trust distinctions, complete-byte verification and the local database.
Resolve routine implementation decisions and defects autonomously. Later
Docker/Node deployment portability and unrelated frontend phases are outside scope.

## Completion checklist

- [x] Audit FP5 requirements and preserve the completed FP4 code/data baseline.
- [x] Define closed, versioned system-backup/recovery contracts and admitted bounds.
- [x] Consistent full canonical snapshot and privileged configuration classification.
- [x] Durable bounded shared-engine backup with retention and visible completeness.
- [x] Privileged upload/admission, inventory validation and recovery preview.
- [x] Fresh-target identity/freshness fences and isolated verified destination writes.
- [x] Identity/history-preserving schema/row restore and safe provider remapping.
- [x] Protected settings/key recovery and paused old operational history.
- [x] Verified recovery report and explicit assisted cutover/loss boundaries.
- [x] Qualified legacy archive conversion and application-independent recovery.
- [x] Complete website backup/recovery, progress, retry and reload reconciliation.
- [x] Native nonempty round trips, fault/concurrency tests and independent review.
- [x] All required checks pass; local data remains preserved; roadmap/checkpoint updated.

## Preserved baseline

`/tmp/fp5-development-baseline/` preserves the tracked patch, all current untracked
files, all 20 migration hashes, a consistent copy of the actual development
database, and FP4's twelve passing canonical checks. This baseline is on `0020`,
File mode is `legacy`, and execution guards are disabled. No baseline data
or historical migration may be rewritten as part of this goal.

## Completion evidence

See [FP5 system backup and recovery](./FP5_SYSTEM_RECOVERY.md) for all twelve
passing canonical checks, native/legacy/offline qualification, final hashes and
exact local data preservation. Real-provider/deployed handoff and concentrated
manual acceptance remain deferred; no later roadmap phase is automatically
authorized by closing this development goal.
