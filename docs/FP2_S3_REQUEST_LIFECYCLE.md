# FP2 S3 request lifecycle preparation

Status: local development following integration head `474a038` (#249). This
slice prepares caller-owned request fencing; it does not complete FP2 native
File access or record deployment/provider acceptance.

## Request boundary

The isolated S3 byte adapter accepts an optional asynchronous `beforeRequest`
check. Each GET, HEAD, PUT or DELETE finishes SigV4 signing, then awaits that
check before constructing or sending the provider request. The callback receives
only a frozen `{ method, key }` containing the original logical object key. It
receives no signed headers, credentials, physical namespace or provider URL.

Only the literal boolean `true` permits I/O. A refusal or thrown exception maps
to the adapter's existing sanitized unavailable outcome. There is no automatic
retry, alternate target or compensating DELETE. A denied streaming PUT cancels
and unlocks its input and aborts its fixed-length output without handing the
request body to the provider. Existing byte size checks remain in force.

The caller owns the check's primary-database lease, incarnation, retention and
deadline predicates. The hook is a request boundary, not durable execution or a
distributed revocation fence: permission changes cannot recall a request already
sent. Authoritative publication and completion must independently recheck the
same ownership. An acknowledged PUT or DELETE alone is not a File commit.
`writeVerifiedBytes` continues to own complete source/destination verification.

## Native reader and compatibility

The registered native S3 reader supports the same caller check while retaining
its final primary-D1 admission/configuration/envelope recheck **after** the
callback. An asynchronous caller check that rotates a credential envelope cannot
send the previously prepared credentials. The rejected call does not retry;
a later explicit call can authenticate the replacement.

In this preparation slice's frozen `0017`/V20 generation, native S3 profiles
remained read-only. The reader exposes only `read` and
`stat`; this slice creates no File locations, write receipts, activation or role
defaults. Existing callers that omit the hook retain their current behavior.
There is no schema or archive change; V20 and frozen predecessors are unchanged.

## Development qualification

Focused host and native workerd tests cover all four methods, delayed/refused/
throwing checks, exact opaque keys, signing order, stale caller ownership,
known-length streams, cancellation/unlocking, and the final native binding
check. Native D1 fixtures exercise paused execution, replacement claim tokens
and expired leases using fresh primary reads. Provider transport is intercepted;
these fixtures do not access real AWS or establish provider acceptance.

On 2026-10-05, the focused lifecycle host, lifecycle workerd and registered
native reader suites passed all 56 tests, including 37 newly added cases.
At this lifecycle checkpoint, the complete CI gate was not qualified: its
native-script stage passed
338 tests but cancelled metrology acceptance/archive recovery and migration
rollback/retry cases at their 240-second and 120-second limits. The migration
case also exceeded its unchanged limit in an isolated rerun. Its rollback and
identical-SQL assertions completed, but the final retry was interrupted by
timeout cleanup. Wrangler's repeated local-runtime startup and cancellation
handling required separate harness work; no assertion or timeout was relaxed here.
The isolated metrology rerun subsequently passed all 34 tests, including
nonempty V20 archive recovery, in 236.77 seconds.

Separate source qualification ran 305 files and 2,570 tests: 2,558 passed and
12 exceeded the existing five-second limit while an earlier interrupted
runner's child processes still competed for resources. After that owned process
tree was stopped, all 99 tests in the seven affected files passed with
`--maxWorkers=1 --fileParallelism=false` and the unchanged five-second limit.
The original source command's failed outcome remains recorded.

The other nine CI leaves passed: mounted UI (76 files / 625 tests), bundled
rich text, export/migration contract typechecks, local D1 migration verification,
Reference and Reference-search Worker/D1 smoke checks, production build, lazy
Map bundle verification and production Project Worker/asset verification.
The shared-module boundary check also passed for all 67 shared source files.

At this lifecycle checkpoint, the separate local D1 database was initialized
with all 17 migrations; the earlier main-branch database was preserved. The
development server on port 3000 returned HTTP 200 for the home page, health,
database readiness, Samples and Projects. These are local development checks.

The follow-on [native File runtime](./FP2_NATIVE_FILE_RUNTIME.md) and
[local FP2/FP3 checkpoint](./FP3_LOCAL_DEVELOPMENT_ACCEPTANCE.md)
implement exact native byte addresses, accepted writes, publication,
cleanup/GC, frozen per-file FabuBlox targets, activation and independent
defaults locally, with `0018`/V21 recovery; `0019`/V22 adds FP3 jobs/migration.
The historical `0017`/V20 restrictions and frozen V7–V20 recovery contracts
remain documented and preserved. These successors do not record deployment
or real-provider acceptance.
