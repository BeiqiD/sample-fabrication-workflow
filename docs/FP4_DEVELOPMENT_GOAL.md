# Development goal: complete the roadmap through FP4

Status: local FP4 development goal complete, 2026-10-06 (UTC).
Owner direction received on 2026-10-06 (UTC).
Integration base: `474a038`; working branch: `codex/fp2-fp3-development`.
The existing FP2/FP3 implementation and qualification remain preserved.

## Scope and authority

Continue independently through the FP4 exit in the
[canonical roadmap](./PRODUCT_ROADMAP.md) and
[portability implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md):
paired native Sample/Project package export and website copy-import, shared
dependency/snapshot planning, included offline HTML/Markdown, independent report
output, and bounded durable execution with progress and safe recovery.

The owner requests continuous iteration and self-review with minimal intervention.
This environment remains development-only. Work includes code, additive schema,
matched archive/offline recovery, automated tests, native isolated runtime fixtures
and fixes necessary to qualify the complete local product slice. No production
deployment, remote production migration, real-provider activation, production
file movement, external messaging or repository push is authorized by this goal.

The owner has deferred concentrated manual acceptance and real-provider
qualification until FP4 is implemented. Keep those exits explicitly pending;
continue appropriate automated checks throughout development. FP5 privileged
system recovery and later Docker/Node deployment portability are outside scope.

Preserve existing work and local data, frozen V7–V22 recovery, authorization,
immutable accepted targets, logical File purposes and complete-byte verification.
Native research import creates fresh business identities and retains origin
provenance; it must not overwrite research, treat arbitrary HTML/SQL as records,
or expose a partially imported graph. Routine implementation choices are owned
by the agent; record and resolve defects before asking the owner to intervene.

## Completion checklist

- [x] Review FP4 contracts, repository gaps and existing FP2/FP3 foundations.
- [x] Preserve the current tracked and untracked work in a local baseline snapshot.
- [x] Versioned domain package/report envelope, strict bounded archive admission,
  dependency rules and documented supported runtime limits.
- [x] Authorized consistent Sample/Project closure and exact frozen File locations
  with durable retention, including sources, comments, graph and placements.
- [x] Offline sanitized HTML/Markdown and independently downloadable report output.
- [x] Durable bounded export, verified output, download authorization and cleanup.
- [x] Website validation/preview and fresh-copy import with destination role mapping,
  naming/provenance, strict integrity and idempotent retry/another-copy semantics.
- [x] Verified File staging followed by bounded atomic graph publication; cancellation,
  interruption, permissions and unknown-write reconciliation remain safe.
- [x] Complete contextual and Settings Data UI, progress, retries and result navigation.
- [x] Matched additive schema/current full archive/offline recovery preserve canonical
  history and leave restored execution disabled, without changing historical readers.
- [x] Nonempty Sample/Project cross-provider round trips and meaningful fault,
  concurrency, corrupt-package, identity and offline-report qualification.
- [x] Required checks pass; self-review defects resolved; roadmap/local checkpoint
  clearly separate completed development from postponed external acceptance.

## Initial evidence

Prior work is preserved in `/tmp/fp4-development-baseline/tracked.patch`,
`untracked.tar.gz` and `manifest.json`. The latter pins all original migrations.
The initial local database had 19 migrations; file and job ledgers were empty,
File mode was `legacy`, and execution was disabled. Its 95 application tables and
the original ledger prefix now remain exact after the local-only `0020` upgrade.
File mode remains `legacy` and both execution guards stay disabled. Database
evidence is recorded in [the FP4 checkpoint](./FP4_RESEARCH_PACKAGES.md).

Use [FP3 development qualification](./FP3_LOCAL_DEVELOPMENT_ACCEPTANCE.md) as
historical evidence; new FP4 behavior requires its own relevant checks.

## Completion evidence

All twelve canonical CI leaves passed in serial stages: 349 verification-script
cases and the shared boundary over 95 source files, 347 source test files with
3,144 cases, 80 mounted test files with 680 cases, and the required type, migration,
runtime, build and production-artifact checks. Nonempty local provider-mapping
round trips, real workerd/D1/R2 execution and matched V23 offline recovery passed.
The final local database proof confirms unchanged application data and disabled
execution. See [the FP4 checkpoint](./FP4_RESEARCH_PACKAGES.md) for exact commands,
limits, self-review fixes, staged results and deferred formal acceptance.
