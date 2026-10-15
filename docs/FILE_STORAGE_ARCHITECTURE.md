# File storage architecture

Status: target reviewed and merged in PR #207; implementation has begun with the
[FP1a dormant registry](./FP1_FILE_REGISTRY_FOUNDATION.md). The complete runtime
model below remains a target until the corresponding FP1 slices are accepted.

Baseline inspected: `v2/backend-foundation` at
`4e78fa76b727f81b1431b60ff481bd686d83cb4c` (2026-09-13).

This document defines the replacement for the current R2/managed-storage split.
It does not claim that the schema, adapters, Settings, or migration jobs exist.
Sequencing, transition compatibility, and acceptance gates are defined in the
[implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md).
[Export and import design](./DATA_EXPORT_IMPORT_DESIGN.md) defines portable data
packages and recovery; [the product roadmap](./PRODUCT_ROADMAP.md) owns priority.

## 1. Scope and decisions

All application-managed persistent bytes use the same file service: research
sources, ordinary images, attachments, previews, import workbooks and manifests,
and generated job output. A user-entered external URL remains an external link;
it becomes managed storage only through an explicit ingestion operation.

The design separates business meaning, immutable file identity, physical
locations, and configured storage instances. It supports a small research group
without a distributed filesystem, global content-addressable namespace, virtual
directory tree, automatic replicas, or a separate generic file-version system.
Existing business revision and occurrence histories retain their responsibilities.

The target storage layer is independent of R2. Every managed file can migrate
between compatible configured instances while retaining its identity and business
references. A provider's limitations may constrain an operation, but cannot
silently reduce its integrity guarantees or redirect its destination.

## 2. Domain model

| Entity | Responsibility and minimum identity |
| --- | --- |
| Business use / occurrence | Existing typed domain relationship, `file_id`, contextual filename/title, order, business role, ownership, and deletion/history state. |
| `File` | Stable ID for immutable bytes with fixed purpose, access/dedup scope, byte size, verified content hash, detected media metadata, and active location ID. |
| `FileLocation` | Stable ID, owning file ID, storage profile ID, opaque object key, lifecycle state, verification evidence, and retention/operation holds. |
| `StorageProfile` | Stable configured instance ID, adapter type, physical namespace, credential reference, configuration revision, and lifecycle state. |
| `FileDerivation` | Source file ID, output file ID, generator/version, normalized parameters or their digest, explicit trust state, and available generation evidence. |

Business tables continue to enforce their real foreign keys. A generic
`owner_type + owner_id` table must not replace those relationships merely to make
the file service uniform. Shared retention queries expose their combined edges.
An attachment's name belongs to its occurrence; deduplicated bytes do not force
unrelated occurrences to inherit the first uploader's filename or description.

Each newly published ready File has exactly one active, verified location belonging to that
same File. Other locations may exist during migration or a retention period;
they are not independently selected replicas. Database constraints and guarded
publication enforce ownership of the active pointer. Pending uploads need not
have an active location. Later provider outage, missing bytes or quarantine does
not erase File identity or its business history: verification-at-publication and
current availability are separate state. Legacy/salvaged unavailable records are
explicitly non-ready and cannot satisfy ready-file publication or complete export.

File identity is not its hash or provider key. Equal bytes may legitimately have
different File IDs. Replacing content creates a new File and changes the relevant
business relationship through its existing revision/replacement operation;
previous references keep their previous bytes. Migration changes a location,
never a File ID, occurrence identity, or business revision.

## 3. Purpose, routing, and durability

Purpose describes why a particular representation is stored. Contextual use
describes where it appears. MIME type and size select validation, rendering, and
transfer limits; they do not determine purpose, placement, or discardability.

| Fixed File purpose | Examples | Default storage role |
| --- | --- | --- |
| `research_source` | Instrument output, original microscopy image, simulation result, or raw attachment retained unchanged. | `originals` |
| `embedded_content` | Comment illustration, user-created diagram, state image, or other content authored for direct application use. | `internal` |
| `derived_preview` | Browser preview or thumbnail intended to represent a source File; derivation trust is separate. | `internal` |
| `provenance` | Original imported workbook, import manifest, or source artifact required to explain/reproduce an imported record. | `originals` |
| `job_output` | Generated report, transfer package, or other retained output of an application job. | `internal` |

A small PNG can be `research_source`; a large illustration can be
`embedded_content`. Showing an original image directly does not reclassify it.
A preview is a separate representation linked through FileDerivation, not a
replacement for the original. Whether a workbook is research data or import
provenance follows the ingestion operation and its business meaning.

The application assigns purpose at a defined ingestion boundary, with the
intended action visible to the user. Arbitrary client metadata cannot select a
privileged purpose or override storage authorization. The first Settings UI
exposes two role defaults, not five unrelated destination forms.

Purpose is fixed per logical File. Reusing bytes for a different purpose creates
a new File under the target purpose and placement policy, using a verified copy;
it does not mutate the source File or its other references. A same-purpose
reference can share a File, subject to access and placement requirements.

Durability is separate from purpose. Temporary uploads, retry windows, and job
output TTLs are explicit lifecycle policies/holds. Generated provenance may be
indispensable; an uploaded illustration may be authoritative evidence. A preview
may be discarded as a cache only when the required source and generation recipe
remain available and no stronger business/export retention promise applies.
Expiration never removes a file still protected by a durable reference.

## 4. Deduplication and derivation

Initial deduplication requires the same access scope, purpose, resolved
destination StorageProfile instance, verified SHA-256, and byte size. It also
requires the File's active, usable location on that instance, outside deletion
or integrity quarantine; a retained inactive copy is insufficient. Provider
type alone is insufficient: two S3 buckets are different destinations.

There is no cross-purpose or cross-scope physical aliasing in the first design.
The same bytes stored as provenance and embedded content can have two independent
File records and physical copies. This preserves independent placement and
retention without adding a global Blob layer and per-purpose placement bindings.
Content hashes are not authorization or public discovery capabilities.

Changing a role default affects new ingestion, including dedup lookup. An equal
file retained on the previous destination cannot silently satisfy a new request
to store bytes on the new destination. Explicitly adding a reference to an
existing File preserves its location and is a distinct operation from ingestion.
Migrating a shared File affects all references to it; moving only one use first
forks its File instead of moving unrelated uses without notice.

A verified derivative records the exact immutable source, trusted generator
version, and parameters. Regeneration creates or reuses a verified output under the applicable
purpose/scope/destination rules; existing outputs and pinned uses are not silently
rewritten. A client-uploaded preview, shared hash, or claimed source relationship
does not prove derivation. Failed generation remains distinguishable from a
verified reusable derivative. Source availability and provenance survive output
cache eviction according to the relevant retention policy.

Imported preview bytes can retain `derived_preview` purpose without trusted
derivation. Preserve foreign source/recipe claims as imported-unverified
provenance, including unresolved claims where necessary; they cannot enter the
trusted shared-derivative registry or justify source replacement/cache eviction.
Archive hashes prove payload integrity, not the transformation. Only local
verified generation or an explicitly qualified trusted recovery procedure can
establish trusted derivation. Byte reuse must not promote a claimed relationship.

## 5. Profiles, deployment defaults, and configuration

| Supported deployment target | Default database | `internal` default | `originals` default |
| --- | --- | --- | --- |
| Cloudflare | D1 | Provisioned R2 profile | Same R2 profile |
| Server / Docker | SQLite | Provisioned local profile | Same local profile |

These are deployment-provisioned defaults; infrastructure still has to supply
the binding or persistent volume. First use must not require external storage
credentials. Additional S3/R2 or WebDAV/SWITCHdrive profiles are optional.
Required combinations include S3 internal files with R2 originals, and server
local internal files with SWITCHdrive originals. R2 through an S3-compatible
adapter can support server deployments without a native Worker binding.
The Local adapter is server-only; a Worker cannot read an arbitrary server disk.
After all Files and held locations leave the bootstrap storage, ordinary file
operations must not retain a hidden dependency on that storage instance.

A profile ID represents one physical namespace, not just `s3` or `switchdrive`.
Changing bucket, account/namespace, root, or endpoint so existing keys resolve to
different objects requires a new profile and explicit migration/rebinding review.
Credential rotation for the same namespace preserves its profile ID. Editing a
profile must never reinterpret historical locations as another bucket or root.

Role defaults select a profile only when a new write begins. An upload snapshots
its destination and configuration revision; later Settings edits do not redirect
an in-flight upload. Existing reads always resolve the File's recorded active
location. A failed selected destination reports its failure; there is no silent
fallback to the deployment default or another service.

Configuration has three boundaries:

- **Bootstrap:** database binding/path, provisioned storage binding/mount, root
  encryption key, and minimal runtime identity configuration needed before the
  application can load Settings.
- **Application settings:** profile metadata, role defaults, limits, lifecycle
  settings, and configuration revisions stored through a validated service.
- **Secrets:** encrypted external credentials, referenced by configuration and
  protected by the bootstrap key; never exported in a portable content package,
  returned in full to the browser, or written to diagnostic logs.

Using provisioned native storage does not require external-secret setup. The
encryption key is required before encrypted credential editing becomes available.

Settings separates candidate configuration, connection/capability checks, and
atomic activation. Tests report authentication, read/write/delete capability,
and cleanup outcome for isolated test objects; connectivity alone is not proof
of write capability. A failed check leaves active configuration intact. Rotation,
encryption-key recovery, and redeployment restore procedures must be documented
before browser-managed credentials ship.

Storage configuration, migration, and profile retirement require a verified
system administrator at the backend boundary. Authentication alone is not this
permission. Record actor, operation, revision, and safe outcome metadata. Reserve
an explicit settings scope with system scope first; future workspace settings
must not gain access to system credentials through that extension.

Validate configurable endpoints and redirects before using credentials: allowed
protocols, namespace constraints, and approved private-network destinations must
be explicit; never forward secrets across an unexpected origin. Server local
roots are restricted to configured mounts, with traversal/symlink escape handled
at the adapter boundary. A web setting is not arbitrary host-filesystem access.

## 6. Storage adapter and file delivery contract

Adapters expose streaming read/write, stat, and delete with precise outcomes for
missing, unavailable, denied, conflict, and failed integrity. Object keys are
opaque to business code. Namespace-safe keys and unique staged candidate objects
avoid overwriting published data. Atomic remote rename is not a required primitive.

Capabilities are declared and checked for the actual operation: byte-range reads,
conditional reads/writes, multipart or resumable transfer, maximum supported
object/part sizes, and trusted server-side checksum evidence. A generic ETag is
not a SHA-256 checksum. Unsupported capabilities require a reviewed fallback or
a clear preflight rejection, not a false claim that all providers behave alike.

All media, preview, and download routes authorize the requesting business scope
before resolving a File. Stable application URLs use logical IDs; provider keys
and permanently public URLs do not become business identities. Delivery preserves
safe inline MIME handling, download filenames/disposition, conditional response
semantics, and documented range behavior. Authenticated cache boundaries remain
valid when the backing provider changes; a cache hit cannot bypass permission.

Transfer plans account for memory, request duration, provider size limits, and
execution budget. No migration or export implementation may assume whole files
fit in browser/Worker memory. Large-file support requires a demonstrated stream
and execution strategy for the selected deployment and provider pair; if an
operation cannot complete with verified bytes, it must not publish success.

## 7. Migration and location lifecycle

Changing a default never migrates existing data. Explicit migration plans list
the selected Files, their usages/purposes, source and target instances, byte count,
capability requirements, and blockers. Jobs persist per-file progress and can
resume after the browser closes or an executor restarts. Retry identity survives
response loss; registration occurs before external writes so orphan candidates
remain discoverable. Default changes and migrations are separate actions.

For each immutable File the operation is:

1. Capture the expected source location and content identity; establish source,
   destination, and job holds before copying.
2. Register a uniquely addressed staging location and stream the source to it.
3. Verify destination byte size and content hash against the trusted File identity;
   use actual destination bytes or equivalent trusted checksum evidence.
4. Mark the candidate ready and conditionally switch the active location only if
   the expected source is still active and the File is not being deleted.
5. Retain the previous source for the documented recovery/read grace period.
6. Explicitly retire and clean up the source after all applicable holds expire.

Retries rediscover their own candidate/result and never delete another task's
winner. A conflicting concurrent switch is reconciled, not overwritten. An
externally modified source fails integrity validation rather than redefining the
File hash. Missing/corrupt bytes and temporarily unavailable providers stay
distinct. A user-supplied historical hash alone is insufficient proof of content.

Reads use the old active location until the guarded switch; new reads then use
the new location. Existing readers must be protected by read leases or an
equivalent enforced maximum request lifetime plus a sufficient cleanup grace.
A simple pointer swap does not prove deletion is safe for an in-flight read.
Rollback is explicit and requires a retained, verified source; no automatic
fallback to an unchecked older copy is part of this design.

Retention operates at both levels: business uses protect File availability;
location-specific upload, migration, export, read, and cleanup holds protect
physical copies. GC rechecks these authoritative edges when claiming deletion.
Recoverable Trash, retryable submissions, pinned derivatives, and package jobs
keep their existing promises. Deleting an occurrence never directly deletes bytes.

A profile can stop accepting new writes while historical reads continue. Final
deactivation/removal is blocked by active locations, retained copies, in-flight
read/transfer jobs, or pending cleanup requiring its credentials. Health failure
is not permission to erase the profile or release retention. Removing the last
readable location of a retained File is forbidden.

## 8. Complete integration inventory and transition boundary

The conversion includes every direct-key path, not only upload/download routes:

- `assets` and `managed_storage_objects`, attachment ingestion, dedup, integrity
  quarantine, GC ledger/retention queries, and permanent-delete planning;
- Comment images/attachments and their canonical/retry/recovery bridges;
- Project-owned attachments, References, source resolution, Canvas/Reading media;
- Run-step attachments, legacy comment images, timeline event image keys and
  Sample thumbnails stored in event metadata;
- state representations, verification evidence, and metrology references;
- import workbooks/manifests, `source_asset_key` references, imported images, and
  import recovery/finalization;
- preview/thumbnail generation and provenance, complete-export enumeration,
  portable-package file maps, restore tooling, and operational diagnostics.

Database records, embedded metadata, route payloads, and exported relationships
must use logical File IDs after the transition. Transitional provider keys are
handled only by reviewed compatibility adapters and migration code. Existing
registration, retention, source authorization, and trusted-derivation invariants
remain required even where their table/module names change.

This proposal does not authorize resetting the test database, replacing existing
D1/R2 bindings, rotating/re-entering SWITCHdrive credentials, or migrating live
files. Preserve existing configured identities and separately review the upgrade
and recovery path in the implementation plan. SWITCHdrive authentication may
remain unavailable while deterministic adapters and other configured providers
validate the design; claims about its real bytes require successful later access.
