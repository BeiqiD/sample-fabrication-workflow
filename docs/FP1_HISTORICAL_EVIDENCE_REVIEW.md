# Historical File evidence review

Status: read-only FP1 review workflow; adjudication writes remain a separate
implementation boundary. Based on accepted integration `4b4eb40` (PR #229).

## Why this boundary exists

The single-item R2 pilot and unaccepted-request withdrawal are accepted. The last
deployed observation after #229 was **overlap, paused, 11 current references,
1 resolved, 10 pending, 0 admitted unresolved and 0 unfinished attempts**.

Seven historical Project references still lack both semantic-purpose and original
storage-namespace evidence. They point to five distinct R2 assets. The previously
accepted V15 archive contains their expected bytes and matching hashes, but no
accepted upload receipt or legacy File mapping establishing the missing facts.
Its occurrence generations are historical snapshot values, not current write
preconditions. Two references can share an asset while retaining different
attachment names and independent purpose decisions.

The existing bytes are therefore useful recovery evidence. Their availability
does not establish why each reference was retained or which physical storage
instance originally owned its locator. File type, filename, Project placement,
matching SHA-256 and the existence of one currently configured R2 profile must
not supply those missing facts automatically.

## Delivered read-only workflow

`/maintenance/file-evidence` identifies current Project attachments by Project
title and attachment name, while retaining their exact typed consumer key.
Selecting an attachment reads its current evidence and generation. The page
shows recorded byte expectations, purpose/profile evidence, blockers and other
references to the same legacy locator. Shared references are independent review
items; reviewing one does not approve another.

The evidence response uses a bounded primary snapshot. Display labels are only
identification aids. They neither replace the typed key and occurrence nor
participate in the existing conversion-eligibility rules. The response contains
an explicit safe projection, not the complete source, profile, receipt or actor
metadata. Provider object keys, raw namespace configuration and credentials are
excluded. A metadata review does not perform HEAD/GET or verify bytes.
The list and each subsequently selected detail have their own observation time;
neither pagination nor a sequence of detail reads is one whole-database snapshot.

This page has no adjudication, conversion, profile-admission or runtime command.
It does not read, dismiss, overwrite or replay the browser's saved conversion
journal. Its page selection is temporary. Reading or refreshing the page changes
neither database state nor conversion eligibility.

There is **no new database migration or archive generation** in this slice.
Migration `0009`, V16 export/recovery and all previously accepted writer guards
remain in place. No File authority activation or S3 configuration is included.
Exact-head checks, deployment and browser acceptance are recorded in the PR as
they complete.

## Information needed for a real adjudication

For each exact reference, an operator needs to distinguish two statements:

1. **Classification now:** why this attachment should be retained as a research
   source. This is an explicit present-day classification decision if the old
   intent was never recorded; it must not masquerade as a recovered upload
   receipt. The initial Project publication protocol only supports
   `research_source`. Another intended purpose remains blocked until its
   publication contract is separately implemented.
2. **Original storage evidence:** the deployment record, operational record or
   explicit historical binding statement connecting that locator to a specific
   registered storage profile and configuration revision. Current readability
   alone does not establish the original namespace. If only a present-day
   replacement copy is known, that is a different recovery-source proposal and
   needs its own reviewed contract.

The seven known test references do not require seven guesses or a blanket
asset-wide classification. The review page provides the concrete items to check.
An operator can leave an unknown item blocked. No credentials or secret values
should be entered into an evidence narrative.

## Next write protocol — requirements, not implemented behavior

The next write slice must satisfy the following together. A metadata form or
ledger without its concurrency, correction and recovery behavior is not an
accepted substitute.

### Exact request and authorization

Use an immutable request ID and canonical request with a digest. Bind it to the
four typed-key fields without trimming or delimiter concatenation, the current
occurrence and generation, source-metadata digest and exact original locator,
the fresh pre-adjudication baseline, and a frozen profile ID/revision. Record
the classification, supporting source reference and separate purpose/namespace
statements. The server supplies authenticated actor and time.

The endpoint requires a separately reviewed server-side operator authorization
boundary. An authenticated identity alone must not be described as verified
ownership. The evidence type must honestly describe an operator adjudication;
it is not a system-discovered historical fact or upload-acceptance receipt.

Start with the ambiguous Project attachment / primary / R2 case and the existing
`research_source` publication contract. Reject contradictory existing evidence,
unsupported providers, other purposes and missing byte expectations. Selecting
an existing profile must check the exact deployed binding without treating that
check as historical evidence.

### Acceptance and generation fencing

Accept only against a fresh primary snapshot and the same epoch/current present
head in the database transaction. Require conversions paused and relevant work
settled. A source, parent, registry, lifecycle, profile or receipt change between
review and acceptance must conflict. Retain the original pre-adjudication
baseline for audit; never reinterpret it against later metadata.

Adjudication is an external immutable overlay. Its insertion/revocation advances
the global shadow epoch, but must not be added to `file_shadow_sources` dependency
JSON: doing so would immediately create a successor and invalidate its own
occurrence binding. Subsequent baseline reads include the applicable ledger
identity/digest in the same snapshot. They require fresh user review before an
explicit conversion. Unrelated later epoch/runtime changes do not by themselves
erase the historical record; source-generation changes prevent its reuse.

### Withdrawal, revocation and correction

Lost acknowledgements retain the exact original request. A read miss does not
permit discarding it or issuing a different request. A withdrawal must durably
seal a never-accepted adjudication ID against delayed requests, or return the
matching accepted record. Reusing an ID with changed input or actor conflicts.

Accepted adjudications require append-only revocation and correction history.
Revocation must fence new conversion acceptance in the database. It cannot
cancel an in-progress provider write, remove a hold or reinterpret a published
File. A pending, unknown, verified or published conversion requires its existing
recovery/publication protocol. A safely unstarted and cancelled operation must
retain its historical link. Do not manufacture a new business generation merely
to correct an operator mistake.

If a corrected record can follow a revoked record for the same occurrence,
conversion acceptance must capture an immutable **operation-to-adjudication
binding** in its transaction. Never infer that binding from the latest record.
The request/revocation ordering, one active record per occurrence and replacement
chain must be explicit database invariants, including `REPLACE` and UPSERT paths.

### Conversion, holds and garbage collection

Both the Worker baseline and native database operation guard must recognize
the same exact occurrence-scoped evidence. Clear only the specific missing
purpose/namespace blockers supported by the adjudication; all byte, lifecycle,
registry, derivation, unfinished-acceptance and conflicting-evidence checks stay.

Do not union new approvals indiscriminately into
`file_shadow_namespace_evidence`. That existing view is locator-global and
would let one reference silently approve its peers. Review its current
operation-acceptance, legacy-hold, source-GC and location-GC consumers separately.
Copy admission and conservative retention have different scopes. A revoked or
stale approval must never release an accepted operation's holds or authorize
provider cleanup. Old Workers already past a metadata read must also encounter
the new database fences.
Adjudication, revocation and audit records are not new byte-retention or download
roots. Existing reviewed business references and operation holds continue to own
source retention; deleting or revoking metadata cannot release those holds.

### Versioned archive and isolated recovery

A future additive migration must ship with a new complete export generation
(expected V17 if no intervening schema change), including adjudications,
withdrawals/revocations, correction chains and operation bindings. Freeze V15
and V16. Old pages must not silently omit newer canonical history.

Validate canonical requests, digests, exact typed identity, source locator and
metadata, frozen profile, actor/time, chain uniqueness and operation bindings.
Validate historical records against retained occurrences and immutable profile
identity, not today's current head or runtime state: correctly preserved evidence
can outlive source deletion, replacement or profile retirement.

Isolated recovery preserves all records and reinstalls their exact guards before
writers resume. It starts paused and performs no automatic adjudication or
conversion. Forward recovery from V16 or older creates empty new ledgers; it
cannot recreate later operator decisions or prove later requests never existed.

## Required acceptance for the future write slice

- Actual SQLite and workerd/D1 behavior, including migration statement splitting,
  immutable rows, `REPLACE`, two competing request IDs, source/profile/parent ABA,
  old-Worker acceptance and revoke-versus-convert races.
- Approving one of two shared-locator references leaves the other ambiguous.
  Corrected evidence cannot reinterpret an older accepted operation.
- Lost acknowledgements and absent receipts preserve the original request;
  authoritative readback and durable withdrawal resolve it explicitly.
- Nonempty current and superseded adjudication/revocation archive round trips,
  tampering rejection before byte requests, exact version negotiation, paused
  restore and old-archive forward recovery without invented evidence.
- A positive live adjudication uses an actual operator-provided classification
  and namespace basis. Repository-development authorization does not provide
  those facts. An unknown item stays blocked rather than being auto-approved.

After that boundary, verified catch-up and invariant qualification still precede
the separately reviewed atomic File authority activation. R2 defaults and basic
Settings finish FP1; external S3 configuration remains FP2.
