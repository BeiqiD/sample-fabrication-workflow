# Performance and operational-readiness fixes

Development checkpoint based on `580cbf7b070987366bd553fa74e2ae9827ff84dd`.
The preceding review measured query calls and archive bytes, and reproduced a
partial-failure polling counterexample. It did not establish production latency,
billing, browser exhaustion or a deployed trigger interval.

This change keeps heavyweight verification local/GitHub Actions. Cloudflare's
single-build/upload path and checked-in daily cron remain unchanged. Main merge,
remote schema application, provider activation and executor enablement remain
separate from these software changes.

## Task lists and status reads

Package and Migration list endpoints use bounded set projections rather than
per-job reads. Public status mapping retains actor privacy, upload/export progress,
publication/hold checks, expiry and cleanup item semantics. The target query budget
is constant for zero through one hundred returned jobs; actual SQL and query plans
are qualified independently from fake-database counting.
The populated plan check verifies primary-key seeks into the selected jobs' child
rows, before and after `ANALYZE`. Selection/sorting of the top-level job history
retains its existing plan; this change does not add a history index or pagination.

Status reads have a per-round cancellation scope and a read deadline. A failed
parallel request cancels its siblings, and the round remains occupied until all
started reads settle. Manual and scheduled refreshes coalesce, with at most one
fresh follow-up. These read signals do not cancel writes or change original-request
identity/retry rules. Hidden pages pause polling; visible active work uses five
seconds between rounds, while idle reads progressively back off to thirty seconds.
Ignoring cancellation cannot authorize an unbounded replacement stream of reads.

## Browser content ZIP

The legacy content export now has explicit application budgets:

| Budget | Default |
| --- | ---: |
| Attachment bytes actually read, including failed integrity reads | 50,000,000 |
| Manifest/serialized metadata | 8,000,000 |
| Generated ZIP | 64,000,000 |

These are content budgets, not guarantees about total browser heap usage.
Known sizes are preflighted and streamed response bytes are checked before final
buffer allocation. Budget violations stop the export rather than silently dropping
content or being converted to provider warnings. Existing ordinary unavailable-file
warnings and the versioned ZIP format remain intact.

A dedicated module Worker performs validation, attachment reads/hash checks and
compression. Cancel or navigation aborts the manifest read and terminates that
Worker; no late completion may create a download. Progress distinguishes preparation,
reading, verification and compression. A new export can start after cancellation.
A durable alternative is only appropriate when that distinct workflow is enabled
and its own capacity/identity semantics fit the intended operation.

## Persistent scheduler preference and schema scope

Reviewed migration `0025_scheduler_fair_turn.sql` adds only an installation-local
`next_queue` field to `file_job_runtime_guard`, defaulting to `package`. It neither
enables execution nor changes historical jobs or a trigger. Previous SQL files are
unchanged. Atomic cursor rotation is fenced by the current enabled runtime
incarnation and active File authority. It survives daily timestamps, missed slots
and process restart. Lost acknowledgements do not justify a second claim/replay.

The scheduler still advances at most one Package/Migration action per invocation;
only idle/unsupported may yield to the other queue. File-only historical schemas
retain their existing path. A dual-queue schema without migration25 reports that
the new scheduler is unsupported; apply the reviewed local schema upgrade before
expecting scheduler execution/fairness. The independent Node runtime's frozen
catalogs and scheduler profiles are not silently upgraded by this Worker migration.

An explicit closed Worker source-schema variant retains the new observed DDL and
its exact fingerprints in content/backup provenance. It does not rewrite the source
to look like current24, relax unknown-DDL checks or refresh frozen V26/V28 pins.
V3 restores and legacy research-only restore targets keep their reviewed inert
catalogs; applying migration25 afterward is explicit and does not enable jobs.
Target verification and scheduler metadata are not activation receipts.

Two-built-version tab recovery remains a separate backward-compatibility check on
the unchanged Version A current24 database. Migration25 is not applied during that
handover. The independent populated current-chain Wrangler rehearsal qualifies the
actual upgrade through25, including original cells/rowids, ledger, failure/retry,
reopen/no-op and the default disabled cursor state.

Real invocation cadence still requires operational qualification. The current
Worker scheduled handler also dispatches Recovery and comment cleanup, so changing
a shared cron changes those frequencies too. A two-minute trigger alone is not a
throughput guarantee: twenty new import files need twenty file steps plus final
publication. Any later multi-step optimization needs a separate overall budget,
per-step ownership and original-resource drain proof under actual platform limits.

## Archive transport

Range-capable readers expose exact offset/length/total-size evidence. R2 supplies
real ranged object reads; ignored, truncated or inconsistent ranges fail closed.
Package held archives and Recovery private artifacts retain namespace, retention,
authorization, execution ownership and cancellation guards. Providers without range
support retain the verified full-stream fallback. Native offline Node positioned
reads remain unchanged.

Full archive validation still verifies complete bytes, CRC/SHA, headers/descriptors
and EOF. Range reads remove repeated prefix transport during member extraction;
they do not remove integrity checks or imply an online time/cost multiplier.

## Qualification checkpoint

The production inputs are frozen before qualification of the final built Worker.
Focused regression counts overlap the complete verification gate and must not be
added together as independent coverage.

| Scope | Local evidence |
| --- | --- |
| List behavior and SQL plan | 71 tests, including actual endpoint query counts at 0/1/9/10/100/105 jobs and populated child-index plans. |
| Polling | 277 mounted tests across 11 suites, plus nine coordinator tests; failure, ignored cancellation, visibility, write acknowledgement and stale-read ordering are covered. |
| ZIP cancellation | Two real Chromium cases against the final build: desktop compression cancellation and mobile SPA unmount, each followed by a successful retry. Both ZIPs independently validate 101 tables, four artifacts and exact PNG bytes. |
| Retained Worker browser flows | Six real Chromium cases for Recovery, Migration and Package using the final build on current25, including refusal, lost acknowledgement, exact-request recovery and copy reuse. |
| Built-version handover | Two real Chromium cases using independently built earlier/current versions on the unchanged earlier current24 database; this is separate from migration25 qualification. |
| Scheduler | 31 focused tests, including independent SQLite connections/process restarts, incarnation/authority fences and lost acknowledgement. |
| Migration25 and compatibility | Three actual populated Wrangler scenarios through25; strict current25 source/backup/restore and unknown-schema probes pass while frozen earlier catalogs remain unchanged. |
| R2 ranges | Exact ranged reads and malformed-range failures, complete archive integrity, retained ownership and actual native R2/Package integration are covered separately from fake-reader byte counts. |

All ten real browser cases passed. The complete local verification is recorded
with the adopting PR after completion.
The adopting development PR and updated main proposal must pass their own actual
head/merge-preview checks; historical passes cannot qualify a later candidate.
Actual provider faults, physical touch/IME, other engines, authenticated deployed
serving/schema handoff and representative real-data performance retain separate
operational release evidence. Canvas batching, additional history pagination and
CI splitting remain measurement-led follow-up work.
