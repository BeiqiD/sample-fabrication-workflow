# Portable capability and installation foundation

This dependent development slice separates verified principal privileges, storage
configuration HTTP and SQL ports, and profile opening from the Cloudflare
wrappers. Existing Worker privilege defaults and route placement remain intact;
Node fixture adapters use actual SQLite, not D1/R2-shaped replacements. Candidate
publication uses native atomic batches, exact revision/CAS checks, encrypted
payloads, direct affected-row counts and independently verified uncertain ACKs.

The generic installer accepts a trusted reviewed catalog and paired recovery
checkpoint. It checks raw migration digests, all recorded prefixes, native
connection ownership and exact local ledger/installation identity. Native
authorizer policy, rollback, bounded writer waits and refused unknown populated
state are real foundations; the separately developed full application catalog
and its scoped current policy are not activated here. Native backup includes
committed WAL state and publishes an independently checked standalone file
without overwriting a competing destination. Shutdown retains ownership when a
reader prevents its bounded checkpoint.

Local identity persists stable principals, versioned password verifiers,
hash-only sessions and separate administrator grants. Current account state,
credential revisions and grants are rechecked. Offline initialization and
destination authority require a trusted stopped-writer fence; imported identity
does not grant authority. Installed construction checks an immutable genuine
SQLite/core/admission tuple before and after asynchronous KDF work. The composer
must retain immutable schema/ledger ownership for the entire service lifetime
and discard the service before migration or recovery. This is not a claim of
per-request full-schema inspection or a deployed local login service.

On the ordered private integration over `7cdee51`, the actual server/runtime-test
typecheck passed. Nine focused files then passed all 159 cases in 42.62 seconds
with one source worker, including genuine SQLite/core/installer/backup/identity,
actual Worker D1 configuration and shared Fetch/Node HTTP surfaces.
[Receipts](PORTABLE_CAPABILITY_INSTALLATION_RECEIPTS.json) bind the applied patch
and source hashes to those actual commands. Module-owner earlier checks remain
separate observations; this combined run does not establish complete CI.

No historical migration or fingerprint, application schema, local File role
default, provider selection, scheduled job, release or recovery cutover changes
in this slice. RT1–RT6 and subsequent small-group authorization remain unfinished.
The foundation PR's prior full-gate failures are retained separately.
