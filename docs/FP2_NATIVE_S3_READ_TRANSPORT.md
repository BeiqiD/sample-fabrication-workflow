# FP2 registered S3 read transport

Status: internal read-transport groundwork merged and deployed in #248
(`889ef20`), following #247 (`07a7d8f`). Native File routing, S3 locations, writes, cleanup/GC, activation
and independent defaults remain behind the existing database and runtime guards.

`nativeS3ByteReader` supplies only `read` and `stat` for an exact registered S3
profile and native configuration revision `1`. Constructing it performs no
database or provider I/O. It has no public route and is not yet connected to
`openShadowProfile`, business readers, export byte routes or upload selection.
The caller remains responsible for business authorization and object-key
selection. Provider metadata and opened bytes are transport observations, not
verified File identity.

The subsequent [profile-bound File GC](./FP2_PROFILE_BOUND_GC.md) removes the
production collector's reconstruction of legacy deletion transports and
strengthens its execution fences. It does not connect this S3 reader or grant
native S3 writes/deletion.

## Exact installation binding

Each operation reads the native profile, runtime and immutable admission receipt
from primary D1. The receipt selects its original candidate profile and candidate
configuration revision, never that candidate's latest revision or another
candidate for the same AWS bucket. The reader checks the canonical native
account/bucket/root identity and digest, the exact admitted configuration digest,
the candidate's physical namespace digest and matching credential descriptor.
The configured AWS owner condition is required and signed on both GET and HEAD.

Credentials are authenticated against the retained descriptor's profile,
revision, credential reference and physical namespace digest for every call.
Plaintext stays inside the operation; the interface returns no credentials or
provider configuration. A candidate edit can change the owner condition,
addressing mode or credentials in a new revision without changing this reader's
recorded target. Adopting replacement credentials or transport settings for
existing native files requires a separate reviewed binding-maintenance protocol.

Historical descriptor re-enveloping is supported through the existing atomic
maintenance service. The new wrapping must still authenticate the same retained
descriptor; its envelope revision cannot precede the admission evidence. An old
readable deployment key can be used, while missing/retired keys, missing payloads,
descriptor swaps and invalid ciphertext return `unavailable` without provider
I/O. This support does not establish that an old key is safe to retire from all
retained check snapshots or installation backups.

After envelope authentication and SigV4 signing, a fresh primary D1 read compares
every source field used for identity, runtime access and credentials immediately
before sending. A wrapping change during preparation fails that operation
without a provider request or automatic retry. A later explicit call may use the
new authenticated envelope. Candidate-head edits do not invalidate this check,
because the head does not own the admitted revision. Requests already sent are
not revoked by later changes; neither a D1 observation nor an S3 owner condition
is a distributed revocation fence.

## Recovery and lifecycle boundary

V20 content recovery preserves the native profile and its admission evidence but
excludes installation candidates and protected credentials. Those portable rows
alone therefore remain insufficient to access S3. Missing installation state
fails closed, even if another candidate addresses the same native namespace.
There is no environment, R2 or alternate-candidate fallback.

No migration or archive change is needed for this internal reader. V20 still
rejects S3 File locations and write/default assignments. Current read-only
runtime state is the only supported state; future activation must qualify and
extend the runtime together with accepted destinations, publication,
cleanup/GC, byte export and paired recovery. The whole-import FabuBlox receipt
limitation still precedes independent storage roles.

## Qualification

Host SQLite and native workerd/D1 tests cover signed account-bound GET/HEAD,
candidate edits before and during preparation, historical wrapping maintenance,
the final-envelope race, missing restored configuration, malformed protected
state, sanitized provider errors and caller-owned stream cancellation. Reads
create no locations/defaults and cannot enable writes. Live AWS acceptance still
requires administrator configuration and is not inferred from fixture transport.

For #247, deployment and online page/default checks passed. The online V20 export
reported all 15 files included, but browser download failed; live ZIP inspection
and isolated restore were not completed. The owner explicitly waived that
remaining live check. Its non-empty paired fixtures and frozen historical archive
qualification remain available; this code-only reader adds no ZIP rehearsal.
