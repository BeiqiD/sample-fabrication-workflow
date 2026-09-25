# Long-term application roadmap

Status: long-horizon direction and compatibility with the active FP track;
not authorization to implement later capabilities

Last reviewed: 2026-09-14 — additive File-authority transition checkpoint

The [Product goal and roadmap](./PRODUCT_ROADMAP.md) owns immediate priority.
The reviewed [file/data-portability implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md)
is in **FP1 implementation**. FP1a–FP1j are merged through PR #219 at exact
integration head `7e63a366663c47c830120abc77af1d174abaf5aa`; FP1k adds an
old-business-path-compatible schema-14 substrate while keeping authority mode
immutably `legacy`; the migration-first complete-export window still requires
the V14 Worker. This track deliberately brings universal
file storage, essential Settings and export/import forward; the previous rule
that only large originals were configurable and every small/derived blob need
not be provider-neutral is superseded. Completed Project and stabilization work
is preserved. Runtime File authority, R2 defaults and Settings are not considered
delivered by the additive substrate or by this document.

## Product scale and engineering stance

The intended deployment serves an individual researcher or a small research
lab/group, rather than a large enterprise. A single server with SQLite and local
storage, or Cloudflare with D1 and R2 defaults, is the initial deployment target.
Database performance changes should follow measured limits. PostgreSQL, Redis,
Kubernetes, distributed workers and horizontal scaling are not prerequisites.

Keep domain identity, file location, authorization and runtime concerns separate.
Favor verified, resumable operations and explicit recovery over provider-specific
shortcuts. Preserve strong integrity/concurrency guarantees while replacing
provisional file persistence where the new model requires it. Avoid speculative
replication, workspaces, ACL tables or per-user infrastructure.

## Intended order and compatibility

| Order | Capability | Boundary with current and later work |
| --- | --- | --- |
| Now | FP1 additive authority substrate | FP1a–FP1j are merged. FP1k adds `0007` and schema-14 recovery in immutable `legacy` mode; it changes no runtime authority, defaults, Settings, credentials, provider I/O or operational holds. |
| Next | FP1 shadow/catch-up and activation | Add the complete shadow writer/resolver and conversion ledger first; only a later atomic cutover may make File-aware reads, writes, retention and lifecycle authoritative. Cross-purpose consumers require independently verified placements. |
| Then | Finish FP1, FP2 and FP3 | Add Cloudflare R2 role defaults and basic authenticated Settings; external configuration and S3; persisted bounded jobs and verified migration. |
| Then | FP4 native packages + matching website import; FP5 full backup + privileged web restore | Share snapshots, file enumeration, integrity and jobs. Readable native packages, reports and system backups retain distinct product/identity semantics. |
| Integrated product | Remaining C4, Phase 5D/E/F and Phase 6B | Refine and qualify enabled file/Settings/data-control surfaces alongside existing workflows; do not repeat completed shortcuts or reset previous phases. |
| Later portability milestone | Node/Docker + SQLite + local default storage | Same product/data/package contracts, actual cross-deployment non-empty import/restore and runtime validation. |
| Later shared-data milestone | Small-group users, membership and domain authorization | Extend the early admin boundary and actor/concurrency seams; no real-time editing requirement. |
| Independently justified | Appearance preferences, measured search/derivatives, optional insight | Do not block reliable files, recovery or the deterministic research workflow. |

The exact FP sequence, gates and compatibility transition belong to the
[implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md). This
long-term document must not introduce alternative phase labels or silently turn
later portability/multi-user goals into an FP release gate.

## Advanced now — universal file management and data portability

This is a dedicated capability track, separate from behavior-preserving Phase 6A.
The durable [file architecture](./FILE_STORAGE_ARCHITECTURE.md) and
[export/import design](./DATA_EXPORT_IMPORT_DESIGN.md) define the detailed
contracts; the following are their long-term commitments.

### File purpose and storage roles

Every managed persistent file is portable, including ordinary images, originals,
previews, source workbooks, import provenance materials and persistent task
outputs. Purpose comes from the business operation, not MIME type or byte size.
Transient scratch/cache objects have explicit retention semantics and are not
silently promoted to durable records or treated as backup content.

Keep business references, immutable logical files, derivation/provenance,
physical locations, configured profiles and write policies separate. The same
provider type may have multiple independent profiles; changing an account,
bucket or root cannot reinterpret historical object addresses. Replacement bytes
create a new logical file. Purpose, derivation and retention are independent:
a small uploaded image is durable unless an explicit lifecycle action says
otherwise, and generating a preview does not authorize deleting its source.

Initial Settings exposes two write-policy roles, `internal` (ordinary/internal
files) and `originals`, with richer internal purpose metadata feeding them:

| Configuration | Ordinary/internal files | Originals |
| --- | --- | --- |
| Cloudflare default after FP1 | Existing R2 profile | Existing R2 profile |
| Later server/Docker default | Persistent local profile | Persistent local profile |
| User-selected example | Amazon S3 | R2 |
| User-selected example after local runtime exists | Local | SWITCHdrive |

Switching defaults affects new writes; historical reads use registered locations.
It does not migrate existing files, repair unavailable providers or silently
redirect a failed upload. Deduplication must respect purpose and destination
policy so it cannot defeat a user's storage choice.

The universal location model supports source and candidate copies during a
verified migration. Copy, verify destination bytes, conditionally switch active
location, retain the source and explicitly clean up under GC safeguards. Migration
is required for both roles, rather than an optional future feature restricted to
originals. This model leaves future replication possible without promising it.

### Essential Settings before personalization

Essential Settings is part of FP, not a distant appearance project. It provides
profile/default management, status and capability checks, connection testing,
validated activation, migration progress and data-control entry points. FP1 uses deployment-provided R2 and can expose authenticated status without
configuration writes. FP2 adds web-managed external credentials and encrypted
secret storage. Any default/configuration mutation, even if brought into FP1,
requires the minimal server-side administrator check before its endpoint ships.

Separate minimum bootstrap configuration (runtime/database/default binding or
local mount and root-key provision), application settings and encrypted secrets.
A web UI cannot supply the infrastructure needed to boot that same UI. Cloudflare
bindings and later container volumes remain deployment responsibilities. Each
supported installation provisions working defaults before optional external
configuration. Protect root-key backup/recovery and rotation; a database copy
without the key is insufficient to recover encrypted credentials. Ordinary
exports never include usable external credentials.

Design configuration scope and identity seams now, initially at system scope.
Do not create speculative workspace ACLs solely to implement a system Settings
page. Credentials belong to the deployment/profile, not an uploading individual.
Configuration, jobs and secrets are services consumed by Settings rather than
state machines hidden inside UI components.

### Export and import as usable product features

Provide three explicit goals sharing one snapshot/file/package/job foundation:

| Goal | Result and identity rule |
| --- | --- |
| Report | Human-readable presentation for sharing/reading; it is not the authoritative import representation. |
| Native Sample/Project data package | Readable HTML/Markdown/CSV alongside versioned structured records, manifest and bytes; website import creates fresh business IDs, reconstructs references and records source identity. |
| System backup/restore | Complete privileged recovery including history/lifecycle state; identity-preserving restore has an isolated preparation and controlled cutover boundary. |

Native package export and matching website import ship and are accepted together
in FP4. A Project package preserves graph/occurrence geometry and authorized source
dependencies, rather than converting references to editable local text or merely
preserving dead source-site URLs. Package import uses destination role policies;
provider credentials/addresses are not authoritative logical file identity.
Report projections can be edited outside the application without silently
changing the structured records that a package importer consumes.

FP5 adds a privileged web recovery flow; retain existing exporter/offline-recovery
coverage in every earlier schema slice. Clearly report incomplete/missing bytes
and do not call a partial package a complete backup. Large data operations need
bounded streaming, progress, retries and interruption recovery outside a single
browser request. The persisted task contract is shared with migration.

## Later project — Docker / self-hosted portability

### Goal and default installation

Run the same product on Node with SQLite and a persistent local file store, using
a documented container volume for database, files and recoverable configuration.
Both initial storage roles use local storage. S3, R2 and WebDAV/SWITCHdrive profiles
are optional extensions. Docker is packaging for the same application, not a
parallel domain model or a different native package format.

The milestone must implement and verify:

- database transactions, migrations, indexes and concurrency on ordinary SQLite;
- safe local paths, durable writes, streaming/ranges and volume persistence;
- the shared profile/role/secret configuration services;
- request authentication and the system-administrator boundary;
- bounded background scheduling, persisted progress, crash recovery and cleanup;
- startup/setup, upgrades, diagnostics, backup and operational recovery;
- actual non-empty Cloudflare ↔ Docker native import and system recovery with
  destination storage remapping and preserved expected identity semantics.

FP's adapter and package design is preparation; it is not evidence that the local
adapter, Docker runtime or cross-deployment acceptance already exists. R2 native
bindings are specific to Cloudflare; other runtimes must access compatible object
services through a supported adapter and credentials. Database copy mechanics
also remain runtime-specific even when recovery semantics are shared.

### Relationship to multi-user

Both hosted and self-hosted deployments need authentication, secret management,
configuration and jobs before complete shared-data permissions. Establishing
those deployment boundaries makes later authorization concrete. The minimum
privileged Settings boundary therefore ships earlier; full membership and
resource sharing remain a separately reviewed project.

## Later project — appearance and personal preferences

Add light/dark/system themes, coherent palette token sets, density and useful
view preferences after evidence justifies them. Keep workflow semantic colors
(Done, Active, Warning, Mismatch and destructive actions) stable across palettes.
Start with non-destructive local preferences; account sync requires an actual
identity/use case. These controls extend the existing Settings area without
becoming prerequisites for storage setup, data export or recovery.

## Later project — small-group multi-user authorization

Complete multi-user support remains a later capability. FP requires a minimal
server-side system-administrator boundary for privileged Settings, credentials,
migration and restore now; this does not imply implementing membership or
resource-sharing schemas. Preserve actor attribution, stable identities,
optimistic concurrency and clean resource boundaries without speculative ACLs.

### Shared infrastructure is a requirement

Multi-user does **not** mean one database or storage stack per user.

The intended model is:

```text
one deployment
one shared database
one shared application/object-storage infrastructure
shared external storage profiles where configured
        ↓
multiple authenticated users
        ↓
logical visibility and capability controls
```

Users share the same physical data infrastructure. Isolation is enforced by authorization over logical resources.

### Samples are collaborative resources

A Sample must not become a private silo tied permanently to its creator. Different users may legitimately process the same physical Sample.

The model should distinguish creator/steward metadata from capabilities. A future Sample permission root may expose a small capability set such as:

- `read` — inspect the Sample and its experimental record;
- `operate` — perform routine fabrication/metrology actions, add records/comments/files, and advance workflow state;
- `edit` — modify higher-level Sample metadata or plans where permitted;
- `manage` — administer lifecycle and collaboration permissions.

Example:

```text
Sample S
├─ Alice: manage + edit + operate + read
├─ Bob: operate + read
├─ Carol: edit + operate + read
└─ David: read
```

This allows Alice and Bob to process the same Sample while preventing unrelated users from silently modifying it.

### Permission roots and inheritance

Do not attach independent ACLs to every Step, Comment, image, attachment, and metrology row by default.

Prefer a small number of domain permission roots:

- **Sample** → Runs, Steps, Comments, experimental attachments, metrology, timeline records;
- **Project** → Project-owned Markdown, attachments, items, placements, and edges;
- **Recipe/Template** → revisions and related authoring operations;
- **application/workspace administration** → storage configuration, membership, backup/restore, and other privileged settings.

Descendants inherit the parent resource permission unless a later proven requirement justifies a narrower override.

### Workspace / membership direction

If multi-user is implemented, a shared Workspace/Lab abstraction is likely preferable to user-owned infrastructure:

```text
User
  ↓ membership
Workspace / Lab
  ├─ Samples
  ├─ Recipes
  ├─ Projects
  ├─ storage profiles
  └─ members / roles
```

A storage connection should belong logically to the workspace/application environment, not to the person who happened to upload a file. A user leaving the lab must not make shared experimental files inaccessible.

Workspace roles and object capabilities should remain separate concepts. An administrative role may control membership, storage, and restore operations without automatically implying unrestricted mutation of every experimental object unless that override is an explicit product policy.

### Authorization is the main engineering cost

The difficult part of multi-user is not adding a `users` table. The difficult part is ensuring that **every read and write boundary** applies the same authorization policy.

Server-side authorization must cover at least:

- direct Sample/Run/Step/Project/Recipe routes;
- attachment/media reads;
- mutation endpoints;
- Search candidate selection;
- Reference resolution and canonical destinations;
- export scopes;
- backup/restore and storage administration;
- any future background or migration operations that act on user-visible resources.

Private or restricted resources must be filtered before results are returned. The frontend must never receive globally searched data and merely hide unauthorized rows client-side.

### Centralized capability checks

Routes should consume shared authorization helpers/policies rather than independently reimplementing ownership checks. Conceptually:

```text
requireSampleCapability(user, sampleId, "operate")
requireProjectCapability(user, projectId, "edit")
```

The exact implementation may use SQL joins, precomputed membership data, or another bounded policy layer, but the semantics should remain centralized and testable.

### Concurrency and attribution

Initial multi-user support does not require real-time collaborative editing, CRDT, or live presence.

The existing direction of:

- stable IDs;
- actor attribution;
- optimistic revisions / expected timestamps;
- operation IDs and exact retries;
- explicit conflict responses;

is sufficient for a first shared-operation model. If two users act on the same Sample concurrently, the authoritative revision/conflict protocol should prevent silent last-write-wins corruption.

Every operation must record the actual actor who performed it even when the resource is managed by another user.

### Storage remains orthogonal

Logical permission follows the domain resource that references a logical file. It does not follow the physical blob location or uploader.

For example:

```text
Sample B
  ↓ attachment
logical file
  ↓
SWITCHdrive location
```

If User A cannot read Sample B, A cannot fetch that attachment even though A and B share the same SWITCHdrive storage profile. Moving the object to R2 or another provider must not change that authorization result.

### Export and administration

Multi-user builds on the FP distinction between:

- readable report/native package export of data the actor may access;
- native package import with domain create permissions and fresh business IDs;
- privileged full-workspace/system backup and identity-preserving restore.

Reference dependencies, file reads, package snapshots and background execution
must enforce that scope as well as foreground routes. A Project permission does
not independently grant access to every source resource it references.

Full restore and storage migration are administrative operations and require stronger authorization than ordinary research editing.

---

## What must remain compatible throughout

Current FP work preserves:

- source, reference-target, Project occurrence and Map placement identity layers;
- actor attribution, optimistic revisions, idempotent operation identity and
  authoritative conflict responses;
- attachment ownership, recoverable deletion, quarantine, GC reachability and
  final physical-delete checks across every file location;
- complete export/recovery schema coverage during transitions, with explicit
  version handling rather than assumptions about prior disposable test data;
- public file/reference navigation that resolves authorized logical files instead
  of exposing provider addresses as stable identity;
- runtime-neutral domain logic and explicit database, storage, auth and job
  adapters;
- existing user-visible media/Comment/Project behavior while backend records evolve.

The currently outstanding S2/6A6 and C4 acceptance remains outstanding. FP design
cannot convert a zero-blob recovery exercise into a non-empty upload/download
pass, infer successful SWITCHdrive authentication, repeat a database reset or
resume held operational controls. Detailed transition and stage checks are in
the implementation plan and activation checkpoint.

Later multi-user extensions must preserve all of the above while narrowing data
visibility server-side. File placement never changes domain ownership; workspace
membership must not depend on the uploader's continuing personal account access.

## Optional later capabilities

Add a rebuildable search index only when representative latency/data volume
requires it. Preserve deterministic eligibility, ranking and lifecycle semantics.
Trusted server-side derivative production remains separately justified; the file
model records source/recipe/trust without pretending every preview is regenerable.
Read-only insight over explicitly selected Project content may follow a stable
deterministic workflow. Replication, automatic tiering/failover, real-time editing
and large-organization features require separate evidence and design.

## Non-goals for the near term

The proposed FP track does not require:

- user/workspace tables solely for future-proofing or per-resource ACLs before
  shared-data work begins;
- per-user databases or per-user physical storage stacks;
- live presence, CRDT/OT or automatic multi-location failover;
- PostgreSQL, Redis, Kubernetes or distributed worker coordination;
- silent provider fallback or destructive migration without byte verification;
- Docker-specific duplicated domain logic or early claims of deployment parity;
- account-level preference sync or appearance expansion before functional needs.

Universal file portability, explicit migration and paired native export/import
are now planned deliverables, not items on this deferred list. Their current
status remains design review, with implementation scheduled only after review.
