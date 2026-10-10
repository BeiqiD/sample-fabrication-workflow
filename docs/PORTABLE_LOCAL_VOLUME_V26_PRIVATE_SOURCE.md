This is a private source candidate, not a completed RT3 implementation or a
qualified V26 checkpoint. No SQLite execution, schema generator, compiler,
runtime test, provider activation or canonical migration registration has run
for this candidate. Runtime qualification awaits the separately owned V25
checkpoint and an explicit test window.

The approved next checkpoint is `portable-runtime/v26`, retaining the installer
catalog family `sample-fabrication-workflow/sqlite-v1`. Its future closed recovery
tuple is business26/image3/records3/system-backup3. Frozen V19–V25 readers, raw
migrations and catalogs are left unchanged. The earlier source design used the
proposed checkpoint spelling `local-volume/v26`; its historical design receipt
is retained, and the implemented private candidate uses the approved spelling.

The source copy combines the clean generic-opening foundation at
`8e8d694196e6aef9cf69f1660e20c5bff8f63e6b` with the exact frozen V25 30-file
handoff from `/tmp/portable-current-v25-apply-final-partial-7cdee`. It is an
unqualified hybrid copy. The first copy attempt rejected one source-hash
mismatch before any runtime operation; that failure receipt remains separate.
The later V25 research ZIP assertion repair and current Worker qualification
belong to the central owner and are not overwritten by this candidate.
The frozen attempt2 candidate remains unchanged. Independent source review
found an old-activation retirement reuse path and an owner-loss window during
the final asynchronous administrator check. The separate attempt3 candidate
corrects these; no runtime failure or passing test is claimed by source review.

The migration adds the closed local/installation tuple to `storage_profiles`
with a hidden-rowid and all-cell preserving rebuild, reinstalls ten exact V25
attached objects, changes 21 explicitly named native/legacy triggers, and adds
five STRICT WITHOUT ROWID tables, three indexes and 18 guards. It retains FKON
and uses installer-owned atomic transaction plus reviewed `defer_foreign_keys`
and `legacy_alter_table` pragmas. This recipe remains unproven for populated
RESTRICT references. The actual native installer test must prove the complete
referenced graph and every unamended observed DDL, including child FK targets;
FKOFF, writable_schema, child deletion and row/type normalization are forbidden
substitutes.

Two tables are protected configuration history and portable:
`local_storage_profile_registrations` and
`local_storage_profile_activations`. The latter's admission UUID is provenance,
not a foreign key to an excluded destination-local table. Three tables are
installation-local and must be empty on a recovered destination:
`local_storage_profile_checks`, `local_storage_profile_admissions` and
`local_storage_profile_bindings`. Source activation history or source read-write
flags do not produce a destination admission. New binding revisions must exceed
retained history, and live operations require the exact fresh binding, successful
owned probe, explicit activation and current physical owner.
Any retirement at the matching activation's binding revision or a newer revision
invalidates that activation proof. Clearing retired_at cannot reuse the old
writer; a fresh higher binding revision and explicit new activation are required.
Retirement intent also fences the amended local-native ingress/role predicates
and new-location path before a runtime flag update. The generic final-publication
guard additionally relies on runtime state; the future service must commit
lifecycle audit and flags atomically, and owned publication integration remains
unfinished.

The canonical namespace is fixed-order UTF8 JSON containing only kind,
lower-case UUIDv4 volume/root IDs and namespaceRevision1. Its SHA256 produces the
`storage-profile:local:` ID. Absolute paths, installation IDs, hostnames, UIDs and
credentials are excluded. Provisioned UUIDs represent operator-managed logical
identity; copying a marker is not proof of the same physical volume. SQL checks
canonical grammar and digest-shaped identity, while the trusted service computes
the digest. A future provider must independently compare it when admitting an
actual owned descriptor.

The registration request accepts only operationId and an opaque trusted
volumeDescriptorId. The uncomposed service uses the existing exact neutral
configuration SQL boundary and rechecks current administrator and installation
owner capabilities. It atomically writes historical metadata and an immutable
operation receipt; the existing runtime seed is read_only. Unknown ACK is
settled only by a fresh primary read of that exact operation/namespace/actor and
attempt timestamp, without a mutation retry or destructive cleanup. The response
reports historical registeredMode, not current provider availability or mode.
The Node-only owned registration SQL view captures the original synchronous
OfflineWriterFence assertion and the actual Node SQLite connection. It rechecks
that owner immediately before native BEGIN, without an intervening await before
the synchronous transaction commits. Primary views retain the captured assertion
even if the caller replaces the method; asynchronous assertions are rejected.
This view is an integration boundary, not an implemented physical lease issuer.
Actual RT2 composition must supply the real held owner; a generic database plus
an isCurrent callback is insufficient. The adapter remains uncomposed.

The private tests are authored around a genuine file-backed, WAL, FKON V25
template created once and CLOSED before each fresh physical copy. They retain
normal default case deadlines; the finite once-beforeAll full-schema setup uses
the existing current-checkpoint fixture's explicit20s setup budget. Fixtures
include a referenced legacy profile, extreme int64 hidden rowids, BLOB cells,
NUL/non-ASCII text and current identity rows. Assertions compare all old table
cells/rowids, every unamended schema object, exact parent FK target, integrity,
ledger and installation identity, plus actual rollback and FKOFF rejection.
Successful upgrade compares all previous23 migration receipts and unchanged
installation fields including created_at. Rollback asserts the specific final
missing-function fault, so an earlier rebuild failure cannot masquerade as the
intended injected rollback proof.
Actual Node SQL registration tests cover readonly state, unchanged defaults and
identity authority, disposal/revocation, immutable replay, conflict and uncertain
ACK, including owner loss during the final async administrator check with zero
native batch calls and zero new profiles. SQL lifecycle tests model probe receipts explicitly; they do not claim
real-disk probing or lease integration. A separate exact code-owned target DDL
fixture tests that imported audit/read-write flags grant zero authority and that
a new destination binding alone cannot reuse the source activation.

Remaining work before any canonical adoption includes actual V25-to-V26 schema
execution and independent review; observed internal-index/current fingerprint
pins; closed current business/image3/records3/archive validation and recovery;
all provider dispatch in ingress/publication/jobs/retention/GC/export; current
Node descriptor/admin/physical writer ownership under the real runtime;
owned disk probing and explicit read-only binding/write activation/default
selection/settings/runbook behavior; before-publication rechecks and persistent
adapter disposal. Local profiles remain unavailable in Worker composition.
An injected generic availability callback alone is insufficient to grant local
write or deletion authority. No resource/group permission derives from storage.

Only the ten new files in the private patch are owned by this slice. Current
catalog, trusted schema generator and image/records/archive dispatch files are
centrally owned; the private expected-schema/catalog helpers are test-only and
are never selected by a production installer.
