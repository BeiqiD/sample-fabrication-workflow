# Portable runtime foundation acceptance

Status: **implemented foundation, integration gate pending; RT1–RT6 are not complete**.

The adoption source is based on `989f1b6ee0b594ddd5492bd890897fc63ca3ef11`.
[PR #252](https://github.com/BeiqiD/sample-fabrication-workflow/pull/252)
subsequently merged at `fc3abc3eac6085cfde8af97b44a9b6d91ac62a15`; both have
tree `15d89bf222c6a16adfc15b857a8f75943b485912`. All four final-head
Verify/Map runs and all 15 status contexts passed before that merge. Its
post-merge Verify and development Workers build remain separate observations.

## Delivered boundaries

- One extracted Cloudflare Hono application factory retains the existing
  middleware/route order and scheduled entry behavior. Business routes still
  consume Cloudflare bindings. Neutral platform authentication/readiness seams
  are exercised through real loopback HTTP and actual file-backed SQLite with
  genuinely signed test identities; they do not supply local account login.
- The Node SQLite capability owns statements, validates exact typed cells,
  distinguishes direct changes from trigger-inclusive changes, fully consumes
  `RETURNING`, and uses synchronous atomic batches. The existing persisted File
  runner consumes that same implementation. Installation identity, migrations,
  recovery ledger admission and consistent backup remain the next RT2 work.
- The actual Node HTTP/static boundary bounds uploads, headers and ownership
  deadlines, handles disconnects/backpressure and cookies, and keeps API
  dispatch ahead of an explicit SPA matcher. Origin comes from trusted
  configuration. Static files require a server-owned immutable build tree.
  Returning a Response ends upload ownership; proxying an unread incoming body
  as a response is outside this boundary's supported composition.
- Pure Node password/token primitives enforce a versioned scrypt policy,
  canonical encodings, constant-size comparisons and immediate bounded
  concurrency. The measured policy uses 160 MiB native memory admission per
  operation, at most two operations and no queue/fallback. Actual private
  measurement observed roughly 364 ms hash / 367 ms verification medians and
  306.3 MiB process peak RSS at concurrency two; this is not a process RSS cap.
  No account, session, grant, cookie, bootstrap or login route is enabled here.
- The disabled local byte capability implements the existing reader/writer/
  deleter contracts and Node incremental hashing. An already provisioned exact
  volume/root/profile marker is required; keys remain opaque and physical names
  are generated digests. Exclusive staging, source verification, fsync and
  immutable atomic publication retain uncertain outcomes for exact-key
  reconciliation. No local profile, default, File publication or cleanup
  admission is enabled by adding this transport.

## Applied-tree checks

On Node `v24.19.0`, the applied source passed **7 files / 103 Vitest cases**,
**15 actual Node HTTP/static cases**, the existing **one independent-process
File runner case**, strict Node production/test and new Worker-test types, and
**6 verification-plan contract cases**. Counts overlap private preparation
receipts and are not summed into a new complete-suite claim.

The default CI/development deployment plan now has **14 mandatory leaves**:
the existing twelve plus `node-http` and `server-types`. The Node `.test.mts`
files are explicitly registered; the new Worker tests have a separate strict
type scope. Existing File runner checks, default deadlines and 15 public status
contexts remain. Full qualification of the final integration tree is pending.

Earlier failures remain recorded: the extracted factory initially broke a
source-layout guard; that guard now checks the actual composition and entry
delegation without dropping route ordering. New test mock/SQLite binding types
needed correction. The HTTP upload initially reset a socket before delivering
413; the corrected boundary passed the unchanged actual rejection assertion.
No failing attempt is counted as a passing qualification.

The [machine receipt](PORTABLE_RUNTIME_FOUNDATION_RECEIPTS.json) pins adopted
source and applied check logs. Temporary private logs may be unavailable in a
replacement environment; the durable record retains their hashes and scope.

The separately applied disk slice passed **31 actual disk cases plus 73
existing byte-contract cases** and the mandatory strict server types. The
synthetic fixtures used `/workspace` overlayfs (`0x794c7630`); `/tmp` tmpfs
diagnostics remain historical. Actual independent-process SIGKILL before/after
publication, a native 1,024-byte process file-size limit, and one lost-ACK write
with fresh independent verification passed. The file-size failure is not
ENOSPC evidence. Power loss, network volumes, arbitrary host mutation and
non-root distribution volumes remain unqualified. The root reviewed the
complete production transport independently of its implementation owner.

## Remaining roadmap work

Continue the [portable plan](PORTABLE_RUNTIME_IMPLEMENTATION_PLAN.md): migrate
the remaining business capability consumers; compose the real Node application;
admit installation/local-profile/identity schema in a paired current recovery
checkpoint; qualify registered disk publication and actual ingress; implement
local accounts/session/bootstrap/keyring policy; run restartable jobs and
cross-runtime recovery; then qualify Docker persistence/upgrades. The following
small-group resource authorization milestone remains open. No production
`main` release, live provider activation or source-data cutover occurred.
