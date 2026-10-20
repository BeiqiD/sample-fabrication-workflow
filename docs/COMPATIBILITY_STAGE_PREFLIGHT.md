# Compatibility stage preflight: proposals only

Status: a local, read-only input validator for the Phase 6A4 A/E/B/C/D sequence.
It performs no network request, deployment, migration, database operation or
resource change. It does not modify its input files or write an approval receipt.
Every result contains `executionAuthorized: false` and
`remoteMutationAuthorized: false`, including a successful A/E proposal.

The existing deployment command is not connected to this validator. This tool
does not by itself prevent another command from deploying. B/C/D must remain
outside automatic remote activation until a separately reviewed executor can
enforce their actual prerequisites. Passing this preflight is never such a
prerequisite proof, and no `--force`, `--deploy` or approval override exists.

## Stage rules

| Stage | Exact predecessor | Schema change | Text-write change | Required rollback floor | Remote preflight result |
| --- | --- | --- | --- | --- | --- |
| A: canonical read bridge | legacy | No | No | legacy | Compatible transition proposal only |
| E: negotiated export protocol | A | No | No | A | Compatible transition proposal only |
| B: additive/default bridge | E | Yes | Yes | E | Blocked |
| C: contraction-compatible writer | B | No | Yes | B | Blocked |
| D: remove compatibility columns | C | Yes | No | C | Blocked |

The rollback floor is a reviewed stage label. The validator does not attest
which actual Worker versions are deployed, available for rollback or retired.
B/D require different source/target schema fingerprints and a migration hash.
A/E/C require identical schema fingerprints and `migrationSha256: null`.
A/E cannot declare a text-write change and still obtain a compatible proposal.

All B/C/D requests in `remote-preflight` mode return
`blocked: unobservable-pre-instrumentation-cohort`, even if every input hash and
timestamp is internally consistent. Advancing the clock or supplying a fresh
context does not change that result. In `isolated-qualification` mode, every
stage may return an isolated qualification proposal; that result does not claim
the rehearsal ran, passed, or can be applied remotely.

## Why the remote barrier remains closed

Cloudflare's deployment API exposes version IDs and traffic allocation. It does
not expose a complete set or count of old in-flight requests. A new deployment
or successful health response therefore cannot prove request retirement.
[Deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/)

HTTP-triggered Workers have no hard wall-time limit while a client remains
connected. The documented 30-second runtime-update grace period concerns
Cloudflare runtime updates, not a guarantee that a user deployment drains all
old requests after 30 seconds. CPU time and the post-response `waitUntil` limit
are also not a universal HTTP request lifetime bound.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Tail logs can drop sampled events. Workers Logs has configurable sampling and
account limits. Absence of old-version log events is not an admission and
settlement ledger for every request.
[Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/),
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

The Beta Delete Version API documents version deletion and an API success
response, not a globally completed termination operation for running invocations
or previously submitted database requests. A deletion receipt is not a drain
proof. An old version still included in the current deployment can also be
selected by version override even at zero regular traffic allocation.
[Delete Version API](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/delete/),
[Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)

The existing application has no admission/settlement instrumentation covering
the historical cohort. Adding instrumentation now cannot retroactively register
those old requests. This bootstrap gap remains a real blocker for B's first
canonical placeholder, C's first legacy-only write, and D's DROP. It must not be
converted into an operator-supplied `drained: true` declaration.

## Input contract and evidence associations

Run the checker with two JSON inputs:

```sh
node scripts/compatibility-stage-gate.mjs --proposal proposal.json --context context.json
node --test scripts/compatibility-stage-gate.test.mjs
```

Exit status `0` means a proposal's input associations passed validation; `2`
means a well-formed remote B/C/D proposal remains blocked; `1` means invalid,
unsupported, inconsistent or stale input. Output never authorizes execution.
The node tests are also part of `test:verification-scripts` in the existing CI
and deployment verification leaf.

Both inputs use `formatVersion: 1`. Unknown or missing fields are rejected at
every record boundary. In particular, `drained`, arbitrary receipts, waiting
claims and caller-supplied authorization flags are not supported. A top-level
`providerProof` is explicitly rejected as `unsupported-provider-proof`, including
`null`, an empty object, or any claimed protocol version. There is no accepted
provider-proof protocol in this implementation.

| Record | Required fields and meaning |
| --- | --- |
| Proposal | `formatVersion`, `mode`, `target`, `predecessor`, `transition`, `qualification` |
| Context | `formatVersion`, `mode`, `target`, `current`, `observedAt`, `approvedTransitionSha256`, `approvedReportSha256` |
| Target, in both inputs | `environment`, `accountId`, `workerName`, `databaseId`; exact match, with validated identifier formats |
| Predecessor / current | `stage`, `sourceCommit`, `schemaSha256`, `deploymentId`; exact match with the independently supplied reviewed context |
| Transition | `stage`, `sourceCommit`, `sourceTree`, `artifactSha256`, `migrationSha256`, `fromSchemaSha256`, `toSchemaSha256`, `rollbackFloor`, `changesTextWrites` |
| Qualification | `kind: "isolated"`, `transitionSha256`, `reportSha256`, `createdAt` |

Git commit/tree hashes must be complete lowercase SHA-1 strings; artifact,
schema, migration and report references use lowercase SHA-256 strings.
The source schema must also match the context's current schema. No schema
fingerprint or migration hash is inferred from a stage name.

`compatibilityTransitionDigest(proposal)` hashes the canonical JSON of format,
mode, target, predecessor and transition. The qualification's transition hash
and the context's approved transition hash must match that digest. The report
hash must match the context's approved report hash. A report or context from
another stage, mode, environment, predecessor deployment, source or artifact
cannot be reused without failing these associations. The helper produces an
integrity reference, not a signature or proof.

UTC timestamps must use the exact `Date.toISOString()` format. Context age is
limited to five minutes; the report must precede the context observation and be
at most 24 hours old. Future timestamps are rejected. These are fixed local
staleness checks, not a drain waiting period. A caller can fabricate timestamps,
hashes and a consistent context: the validator does not prove their origin,
actual provider freshness, file contents, or that tests passed. The CLI does not
read a referenced report or fetch deployment state. A future executor must
obtain and verify those facts independently before considering any action.

The target identity here is limited to the D1 text/schema transition. It is not
an R2/provider-cutover validator. An isolated rehearsal may use synthetic
environment and deployment IDs consistently; those IDs must never be presented
as a remote observation.

## Requirements for any future proof protocol

A separately reviewed protocol would need exact runtime version identity,
atomic admission and sealing, and complete settlement accounting across HTTP,
response streams, cron and background work. The version metadata binding can
provide runtime version IDs; it does not itself provide retirement evidence.
[Version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)

The implementation would have to reject late admission after a cohort seal,
retain unknown D1 outcomes until settled, and never equate a timeout, expired
lease, client disconnect, or unconditional `finally` decrement with completion.
It would also need an independently verifiable bootstrap treatment for requests
that began before instrumentation. No such treatment is implemented here.
Until that gap is resolved, new evidence formats must remain unsupported and
remote B/C/D activation must stay blocked. Local compatibility matrices,
restore rehearsals, final schema generation and review can continue separately.
