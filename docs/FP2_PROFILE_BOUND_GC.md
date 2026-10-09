# FP2 profile-bound File garbage collection

Status: merged in #249 as `474a038e3eb79b4251b949458e252805f7851cac` and deployed
on 2026-10-03. All 14 commit statuses and both merge-head Actions workflows passed;
Cloudflare build `4ba3cd7a-1e22-49ec-958a-4c3fb23ebf65` deployed Worker
`faa8a01b-0fc8-47d7-b59e-81e038bc4310`. This is an FP2 lifecycle prerequisite;
native S3 File writes and deletion remain unavailable under `0017`/V20.

The post-deployment browser observation retained both upload roles on R2 and
File authority Active/Enabled. Historical shadow maintenance reported 4 resolved
of 5 current references, one pending and zero unfinished attempts. Both Project
historical references appeared resolved; the pending source was not identified.
This is a diagnostic follow-up, not an assertion that all five are resolved or
that a new authority transition is needed. No live cleanup was invoked and the
owner-waived ZIP exercise was not repeated. This remains a 2026-10-03 observation.

## Exact deletion capability

The File collector previously opened an exact historical profile for HEAD, then
reconstructed DELETE from a legacy R2/SWITCHdrive locator and the environment.
`openShadowProfile(..., "write")` now returns a `ByteDeleter` bound to the same
captured physical instance as its reader and writer. Read access exposes neither
a writer nor a deleter. The returned profile tuple is immutable, and construction
performs no provider I/O, profile registration or role-default selection.

Before every DELETE, the bound capability reads the exact profile and runtime
through a new `first-primary` D1 session. It requires the recorded namespace,
configuration revision, source and credential-reference convention, historical
identity and `read_write` runtime. It also compares the captured R2 binding and
namespace, or SWITCHdrive endpoint/root/provider/authentication configuration,
with the current environment. A change or failed observation returns only the
safe `unavailable` outcome and prevents provider I/O.

The optional `beforeDelete(key)` callback belongs to the lifecycle caller. It
runs after profile revalidation and immediately before the captured transport;
false or an exception prevents deletion. The capability retains the existing
acknowledged/denied/unavailable contracts and performs no retry, fallback,
content read, metadata probe or database mutation.

## Collector execution fences

The collector captures its initial database and enabled File-authority
incarnation. Candidate maintenance, File retirement, orphan marking and lease
claiming all require that same enabled incarnation. A replaced incarnation does
not authorize the old invocation to continue.

Every pre-I/O claim check uses a fresh primary session and verifies the complete
lease tuple: location, operation, attempt and deletion start. It also verifies
the exact profile/revision/adapter/namespace/key, write access, active authority
and all retention predicates, including retired File holds and shadow/legacy
holds. The bound deletion callback repeats this check after the profile's
asynchronous revalidation. DELETE is obtained directly from the opened profile;
no legacy locator is synthesized.

Successful finalization and failure recording use atomic conditional updates
with the same lifecycle fence. A pause, replaced incarnation, reclaimed lease or
new hold leaves the claimed ledger unchanged. In particular, a pause during a
DELETE acknowledgement neither publishes `deleted` nor triggers an unguarded
failure-record update against the native paused-execution guard.

An uncertain deletion remains claimed. After lease expiry, a new authorized
invocation can observe missing bytes through the same captured reader and finish
without issuing another DELETE. Registration grace, orphan grace and the
15-minute claim lease remain the existing policies.

These observations do not make D1 and a provider request atomic or revoke an
already-started request. They do not authorize key reuse or establish provider
version fencing. Native lifecycle guards and retained uncertain claims continue
to protect attachment and retry behavior.

## Qualification and compatibility

Seven added profile-capability tests and four added host collector regressions
cover immutable targets, fresh primary sessions, final callback failure,
environment changes, safe SWITCHdrive denial, legal pause/re-enable during
HEAD/DELETE, and late File holds. Four native workerd tests apply every current
migration to real D1 and use two actual local R2 bindings: exact deletion keeps
the same key in the other bucket; a pre-DELETE pause prevents I/O; a pause after
physical deletion prevents finalization; and a reclaimed lease rejects the old
acknowledgement. Real lifecycle guards are installed during collection, foreign
keys remain valid, and live provider fetches are forbidden in the fixture.
The focused suite passed 53 tests across six files; Worker typechecking and the
production build passed. Independent review found no blocking issues.

No content schema or archive changes are required. V20 and frozen predecessors
remain unchanged, and this service does not add an activation or default-change
route. Native S3 byte addresses, accepted write receipts, File-only business
bindings and paired recovery still require a reviewed successor generation.
At the #249 / `0017` / V20 checkpoint, the FabuBlox whole-import target also
needed per-purpose frozen receipts before internal/original defaults could
diverge. This historical prerequisite is locally implemented in the synchronized
FP2 successor; its integration and provider acceptance exits remain open. See
[the current FP2 status](./PRODUCT_ROADMAP.md#fp2-completion-units).
Real AWS and SWITCHdrive qualification
remain separate deployment acceptance; the existing waived live ZIP exercise
is not repeated for this runtime-only change.
