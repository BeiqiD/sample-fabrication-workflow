# FP1c: provider-neutral writes and bounded byte verification

Status: bounded FP1 implementation after [FP1b](./FP1_BYTE_READER_BOUNDARY.md).
Development base: `1f47a81` on `v2/backend-foundation`, 2026-09-13.
This is a precursor to complete File consumer/lifecycle conversion. It does not
activate the [FP1a registry](./FP1_FILE_REGISTRY_FOUNDATION.md) or complete FP1.

## Delivered boundary

[`ByteWriter`](../worker/files/byte-writer.ts) accepts an already-bound storage
instance, opaque key, byte stream or supported buffer, and write metadata. The
R2 and managed adapters declare accepted input forms. They acknowledge transport;
they do not select profiles/defaults, grant access, register database state,
publish logical Files, retry uncertain writes or delete objects.

The verified-write service composes a writer with a reader for the **same
concrete instance** and an explicit incremental SHA-256 capability. It checks
source size/hash, requires source EOF, then reads the destination's complete bytes
and checks their size/hash independently. An acknowledged PUT or matching HEAD,
ETag or custom checksum field is insufficient. A stream failure, unexpected size
or different content prevents successful verification. An early acknowledgement
cannot certify source bytes that the provider did not consume.

[`legacy-byte-writer`](../worker/files/legacy-byte-writer.ts) supplies the current
Worker runtime composition. Existing R2 and managed attachment registration use
it after their durable candidate registration. R2 input buffers are checked before
PUT; managed streams are checked while forwarded with backpressure. Managed
dedup/reconciled paths must consume and check the accepted upload body even when
they do not need a new PUT. Each selected reused destination is read and checked
for that operation rather than trusting its legacy `ready` label and stat alone.

The FabuBlox importer uses the same R2 write/verification composition for source
workbooks, manifests and images. Every new asset remains durably `pending` under
its owning import before provider I/O. Both initially found and registration-race
winners are checked before adoption. Its existing batches of at most five writes,
lease, staged metadata visibility, atomic finalization and lost-response recovery
remain in place. A verified candidate does not bypass the owning import's
publication gate.

## Resource and failure contract

The verifier accepts a safe nonnegative expected size of at most **100 MiB** and a
lowercase whole-object SHA-256. It checks actual bytes against that size during
consumption and requires an exact match at EOF. Existing 5/10/25/50/100 MiB
operation limits retain their own applicability; this transport ceiling does not
raise an endpoint's limit. The FabuBlox multipart payload remains limited to
50 MiB and its existing step/image count.

Hashing uses one backpressured reader and an incremental hash sink, with at most
64 KiB supplied per hash write. It neither tees a stream nor accumulates the
whole object for hashing. It still holds the upstream producer's current chunk;
this is not a claim that arbitrary producer allocations are bounded. Existing
buffers are exposed through 64 KiB views of the same backing ArrayBuffer, without
an object-sized `Response` body copy. R2's adapter currently accepts buffers;
streaming R2 writes require separate known-length transport qualification.
Existing
HTTP `arrayBuffer()`/`formData()` parsing and retained FabuBlox input buffers are
unchanged. This slice does not qualify unbounded uploads, resumable transfer,
durable jobs or an end-to-end streaming HTTP ingress implementation.

Cancellation/failure releases the reader and hash sink. A lost PUT response,
failed destination verification or inaccessible provider never causes automatic
replay, fallback or inline DELETE. Existing registered `pending`/`failed`
candidates remain owned by the current reconciliation and GC rules. FabuBlox
failure queues its metadata cleanup through the existing lease-aware path and
keeps the bytes for authorized cleanup. This does not grant new deletion power.

Error messages are fixed and exclude provider exception text. Definite source
size/hash mismatch is reported as invalid input; unavailable/incomplete
verification remains an unavailable operation. Historical corrupt reuse is
rejected for the current operation without inventing a new quarantine reason or
silently rewriting historical expected metadata.

## Evidence and compatibility limits

Verification is evidence from a particular operation's complete read of a
specific instance/key. It does not pin a provider version or promise protection
against later external mutation. No durable File/Location verification evidence,
active pointer, credential revision, new operation acceptance ledger, profile
selection or role default is introduced. Legacy registration, import ownership,
retention, quarantine and GC remain authoritative.

This improves new ingestion and the reuse paths checked during that ingestion.
It does not retroactively certify all historical `ready` rows, all existing
references, independently invoked recovery paths or every future read. The FP1a
observations remain immutable and unresolved, with null verified hashes and
active pointers. Byte verification alone does not establish trusted derivation
for user-supplied previews or permission to reuse bytes across purposes/scopes.

There is no schema, archive protocol, storage binding/default or credential
change. Current schema 9 / writer 1 / `fp1-legacy-overlap` remains in force.
ZIP-specific and browser ZIP acceptance are deferred at the owner's request;
this slice does not claim a completed archive download or round trip.

## Qualification and next boundary

Focused verification covers source/destination mismatch, same-length corruption,
missing/unavailable destination, late stream errors, source EOF, cancellation,
size ceilings, bounded incremental hashing, independent instances and uncertain
write ownership. Registration fixtures cover initial, reconciled and concurrent
winners. FabuBlox route fixtures cover actual workbook/manifest/image bytes,
registration-before-write, at most five concurrent writes, rejected corrupt
winners and failure cleanup without provider deletion. Existing import
publication/lost-response fixtures remain part of the ordinary verification gate.

The [native runtime qualification](../scripts/fp1-byte-verification.test.mjs)
uses the actual services and Worker `DigestStream`: a generated 100 MiB managed
stream and its independently generated destination both match a host Node SHA;
each hash write is at most 64 KiB, and the source leads consumption by at most
one producer chunk. A 10 MiB source uses the actual local R2 binding for PUT and
GET, retains the original input buffer during source hashing/PUT, and matches an
independent digest. Failure cases include equal-length corruption, truncation,
late read failure, rejected over-limit metadata and an unknown PUT result.
These results qualify local workerd behavior, not remote provider performance or
the deployment account's CPU quota.

The PR records the final executed local/CI checks, independent review, deployment
and applicable browser acceptance. Deterministic fixtures do not establish live
SWITCHdrive access. No ZIP-specific acceptance is performed for this slice.

[FP1d](./FP1_FENCED_BYTE_DELETION.md) extends the transport boundary to deletion
and fixes uncertain-delete/stale-executor handling in the existing GC service.
It leaves File authority dormant and records the concrete conversion inventory.
The next authority change must convert the complete consumer, deduplication,
quarantine and retention inventory together, with accepted operation identity,
profile/default races, guarded File publication and matching recovery coverage.
Only that reviewed transition may relax the FP1a unresolved-state guards. R2
defaults for new originals, role readiness and authenticated basic Settings
remain subsequent FP1 work under the
[implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md).
