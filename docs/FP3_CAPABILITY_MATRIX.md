# FP3 runtime and provider qualification

FP3 runs one persisted File attempt per independently invoked execution step. A
plan accepts at most 100 explicit File IDs and five unique candidate attempts per
File per job; each File is limited to the existing
100 MiB byte-verification bound. Incremental hashing forwards at most 64 KiB per
hash write, with backpressure. These are development bounds, not measurements of
a deployed Cloudflare plan. Larger objects and selections fail before acceptance.

| Runtime / storage | Existing capability | Qualification still required |
|---|---|---|
| Worker / R2 | Full GET/HEAD, known-length streaming PUT, DELETE, incremental Crypto.DigestStream; qualified distinct deployment-owned profile-to-binding registry | Deployed CPU/memory/elapsed limits, remote interrupted PUT and scheduled invocation limits |
| Worker / AWS S3 | Native writable File generation; full GET/HEAD, signed known-length streaming PUT, DELETE, final lifecycle fence | Live exact-instance tests and remote interruption limits |
| Worker / SWITCHdrive | Full GET/stat, streaming PUT, directory creation, DELETE; fence each MKCOL and byte request | Qualified interrupted-write visibility and live access when available |
| Node / local fixture | File-backed SQLite, native incremental SHA-256, bounded Web/Node streams | Supported production filesystem namespace, root/symlink policy and Docker runtime are later work |
| Node / AWS S3 | Neutral job kernel accepts an injected exact-instance transport | Node known-length fetch adapter and live provider qualification |
| Node / R2 | No Worker binding in Node | Explicit R2 S3-compatible transport; a local disk fixture is not R2 |
| Node / SWITCHdrive | Web streams/fetch primitives available | Neutral credential binding, request semantics and interrupted-write qualification |

The current byte reader supports whole-object reads only; no range, multipart,
conditional version or mid-object resume capability is implied. File attempts
resume through unique registered candidate keys. Unknown PUTs retain destination
holds; a lease timeout or missing HEAD cannot authorize deletion. Recovery may
publish a verified candidate only after positive settlement, or after a qualified
atomic, single-PUT provider proves that its unique object was committed.
Resume reconciles the current candidate. An explicit retry may register a new
unique attempt while earlier unknown keys remain held; dry runs budget up to five
retained candidate copies per job. Unknown copies retained by prior jobs are
separate obligations. Exhausted attempts require a new reviewed plan rather
than unbounded automatic writes.

`scripts/fp3-transfer-spike.mjs` exercises bounded incremental source and
independent destination hashing, backpressure, corruption, early acknowledgement
and interrupted archive output using local fixtures. It rebuilds an interrupted
archive under a new key; it does not append to an unfinished ZIP or qualify a live
provider. The native workerd cases below additionally qualify the actual R2/S3
FixedLengthStream and Crypto.DigestStream mechanics locally.

Local development evidence: the Node 16 MiB spike passed with 256 source chunks,
64 KiB maximum source chunks, independent full SHA-256 and interrupted ZIP rebuild
under a new output key (423 ms). `worker/files/jobs/transfer-workerd.test.ts` also
passed its 16 MiB native R2-to-signed-S3 fixture with DigestStream,
FixedLengthStream, 64 KiB hash writes and corrupt readback rejection (5.08 seconds
including harness setup). These fixtures qualify runtime mechanics; live provider
timing, maximum-size memory/CPU and a deployed scheduler remain separate evidence.
The same native workerd transfer case subsequently passed at the declared maximum
100 MiB, with full source and destination hashes and corrupt readback rejection,
in 11.68 seconds under the unchanged 60-second step budget. This qualifies the
local maximum-size transport path; deployed CPU and memory limits still require
measurements on the actual Workers plan.
The actual local S3 transport suite also passed R2-to-S3, S3-to-S3 and S3-to-R2
migration, corrupt readback pause and explicit retry, pending Comment completion
after item migration, and held-stream source cleanup with physical File GC. Its
six cases passed in 21.9 seconds. They use isolated local provider endpoints,
not production storage credentials or bucket mutations.
An actual native workerd fixture with two distinct local R2 bucket bindings also
passed an 8 MiB migration and stable File read in 23.17 seconds. Live source/read
holds blocked physical GC; after EOF an unresolved legacy occurrence sharing the
old key still blocked it. Resolving that actual business occurrence to the verified
File under all SQL guards admitted deletion of only the old source bucket object,
while preserving the target object and historical alias. The populated native
17-to-18-to-19 upgrade preserved old cells and 64-bit rowids, with clean catalogs,
foreign keys and quick-check results.

The proposed dispatcher cadence is two minutes, one bounded step per invocation,
with a 60-second transfer budget and 15-minute fenced claim lease. HTTP acceptance
persists work; browser polling reads status. A persisted Node loop independently
invokes the same kernel and survives process restart. Executor heartbeats expose
missing/stale dispatch. The existing daily Cron is not this runner's acceptance.
Recorded Cron/Build holds are not released by this development; their live state
has not been rechecked. No trigger change or deployment is part of this work.
Actual Workers plan limits and provider transfer timing
must be recorded before enabling a deployed scheduler.

Published reads acquire a 15-minute durable exact-location hold and enforce a
two-minute stream lifetime. Migration and source-cleanup holds are explicitly
released, never expired merely because an executor lease ended. Old-source cleanup
is separately accepted, waits for its grace boundary and checks current retention,
read holds and a usable required copy. Unavailable providers retain visible cleanup
obligations. Restored job history grants no execution or cleanup authority.
Explicit installation enablement pauses both queued and running jobs with
`executor_reconfigured`; a selected job needs an explicit resume. Cleanup audit
timestamps and actors remain portable history, while an installation-local
per-job cleanup grant requires a fresh explicit request in the current executor
incarnation. Global enablement alone cannot replay historical cleanup or release
source/candidate holds. Recovered finite read holds retain their original expiry;
new streams acquire independent holds. A dead reader's expired hold does not
authorize a write or bypass the active pointer, retention, or live read guards.
Every copy step still rechecks its original migration actor's current system
administrator authority before provider requests and publication. Cleanup is a
separately accepted installation maintenance operation: within the same enabled
incarnation it does not depend on later changes to the migration actor or cleanup
requester's role. Pausing a copy job does not cancel its accepted cleanup request.
Disabling/re-enabling the executor invalidates the cleanup grant, and a current
administrator must explicitly request cleanup again. Cancellation retains all
written candidate holds until that explicit cleanup; only candidates whose PUT
never began can release their holds immediately.
V22's two isolated nonempty recovery cases preserve verified migration and
unknown-write attempt history exactly, restore the executor disabled, and restore
zero local cleanup grants despite a granted source installation. The final 0019
whole-file and individually prepared Wrangler statements install equal schemas
with clean foreign keys and the same disabled admission defaults.
