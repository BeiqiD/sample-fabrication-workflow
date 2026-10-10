# V21 full recovery integration test budget

PR254 head `a482b10` own push Verify passed the complete plan, while its own PR
Verify failed one source case: V21 original registration/source-rowid recovery
reported 7301 ms against the default 5000 ms. Its only failure was the deadline;
no functional assertion failure was reported. The failed run and skipped later
leaves remain recorded in [receipts](SOURCE_CI_RECOVERY_BUDGET_RECEIPTS.json).

That single integration case now gets an explicit 15000 ms budget. It still
builds a real ZIP, writes its bytes, copies trusted migration SQL, constructs an
independent physical database with all fourteen real migration executions and
four fresh validation boundaries, and checks every recovered table, exact
9007199254740993 rowid, absent local credentials, paused execution and zero
provider I/O. Its entire body and all assertions are byte-identical. The global
5000 ms default and every other case remain unchanged. Existing full V7 restore
cases and the positive V8 restore also have 15000 ms integration budgets; the
V21 real-native-bytes sibling uses 30000 ms.

A genuine scheduling A/B ran all forty unchanged V20/V21/V22 cases on four CPUs:
both three-worker and two-worker runs passed40/40, but the exact V21 recovery
case measured2201.65/2205.77 ms and whole wall time33.63/47.93 seconds. The trial
did not reproduce the remote failure or improve recovery cost. Its two-worker
configuration was rejected, and the original source scheduling is retained.

This is a bounded integration-test budget adjustment, not a latency repair or
a guarantee of future CI success. The complete V21 file passed11/11 in17.52 seconds on the changed candidate.
A preparation attempt with missing clone dependencies failed before any case
ran and is retained separately; the successful attempt reused the existing
lock-compatible workspace installation. Complete local and own push/PR checks
on the final submitted head are still required before merge. No product migration,
validator, timer, provider behavior or recovery protocol changes here.
