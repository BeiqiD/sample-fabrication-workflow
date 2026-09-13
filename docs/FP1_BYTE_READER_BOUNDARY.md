# FP1b: provider-neutral byte reads and legacy route convergence

Status: bounded FP1 implementation after [FP1a](./FP1_FILE_REGISTRY_FOUNDATION.md).
Development base: `5a003ea` on `v2/backend-foundation`, 2026-09-13.
This is a precursor to verified ingestion and complete consumer/lifecycle
conversion, not completion of FP1.

## Delivered boundary

[`ByteReader`](../worker/files/byte-reader.ts) receives an already-bound storage
instance and an opaque object key. Its full-object read/stat contract contains
no Cloudflare environment, SQL, profile lookup, authorization or retention
decisions. The R2 and managed adapters implement that transport contract; two
instances of the same adapter need not share storage. Runtime composition for
historical singleton locators lives in
[`legacyByteReader`](../worker/files/legacy-byte-reader.ts). It validates the
recorded provider and never falls back to another provider. It does not invent
a persistent namespace from a binding label or resolve arbitrary profile IDs.

The shared `getBlob`/`statBlob` operations now delegate to these readers. The
four remaining direct download routes also use `getBlob` after their existing
SQL authorization and visibility checks: legacy R2 assets, execution-image
reference media, live Comment originals and full-export Comment originals.
Existing source IDs, URLs and live-versus-export quarantine/Trash rules remain
in force. No read registers, repairs or promotes a File or Location.

The transport distinguishes definite absence, provider authentication denial
and other unavailability. The legacy API keeps its existing `missing` versus
`provider_unavailable` shape; both denial and unavailability map to the latter.
Provider exception text does not cross that boundary. The converted routes
return 404 for confirmed absence and a stable 503 for storage failure, without
mistaking a provider credential error for missing application authorization.

An available result transfers the original stream to its caller without reading
or buffering it first. The caller owns consumption, cancellation and later
stream errors. Adapters release bodies opened but not handed off. Standard R2
representation metadata, including encoding, language and expiry, survives the
boundary; media routes still impose their own content type, disposition, cache
policy and security headers. The managed reader preserves its existing limited
content-type/ETag metadata contract. Size and ETag are observations, not verified
SHA-256 evidence. Range, conditional reads, automatic retry and resumable
transfers are not capabilities of this interface.

## SWITCHdrive transport safety

Every authenticated WebDAV request now uses manual redirect handling. A redirect
is an operation failure; credentials and request bodies are not replayed at a
different URL. Unused response bodies are cancelled on success and failure;
successful GET bodies remain caller-owned. This also covers the existing
connection probe, directory creation and explicit DELETE operation.

A successful PUT followed by a missing or size-mismatched HEAD fails validation
without an immediate provider DELETE. Existing ingestion registers a distinct
candidate before upload; a failed or uncertain attempt remains tracked and
non-public for the existing reconciliation and GC rules. Losing a PUT response
does not cause an automatic replay or delete. This changes transport cleanup,
not deletion authority, grace periods or the registration state machine.

## Compatibility and remaining work

There is no migration, archive protocol change or new HTTP endpoint. Full export
remains schema 9 / writer 1 / `fp1-legacy-overlap`, with existing v7/v8 isolated
recovery support. FP1a observations remain immutable, unresolved and dormant;
legacy metadata and retention are still authoritative.

The subsequent [FP1c slice](./FP1_VERIFIED_BYTE_WRITES.md) converges legacy PUTs
and verifies current ingestion/reused bytes before legacy publication. It does
not activate File authority or complete the lifecycle conversion below.

This read boundary does not convert legacy writers. R2/managed ingestion,
FabuBlox writes, registration/reuse, quarantine and operation-ID GC still use
their existing contracts. The full consumer/lifecycle conversion must establish
verified bytes, guarded File publication, recorded profile/configuration
identity and complete export/recovery before relaxing FP1a restrictions. New
original defaults, role readiness, authenticated Settings and external provider
configuration remain subsequent work. No default or credential changes here.

## Qualification

Focused tests cover stream ownership and late failures, safe metadata and error
handling, same-type instances, malformed provider combinations, authorization
before storage I/O, live/export visibility, redirects on every authenticated
method and failed/uncertain upload cleanup. Existing registration and lifecycle
regressions remain part of the ordinary verification gate.

Historical E/B4 Worker qualification still checks the original C and E source
hashes. An explicit test-only patch first restores the changed Comment route
to its frozen C input, then the existing C → B → E reconstruction runs unchanged.
Current input hashes are checked separately; updating the reconstruction input
does not redefine either historical version. Actual host SQLite/D1 compatibility
and rollback tests exercise the resulting old Worker.

The PR records the final local/CI results, independent review and deployed
version. Local adapters and Worker/D1 fixtures do not establish live SWITCHdrive
access, new R2-original policy or a completed backup download. Follow the
[activation checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md) for outstanding
live acceptance and operational controls; this slice requires no reset, binding
change, credential rotation or Cron change.
