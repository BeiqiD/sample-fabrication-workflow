# Long-term application roadmap

Status: long-horizon product and architecture direction; not an active implementation plan

Last reviewed: 2026-08-16

This document records product areas that are intentionally **not** part of the immediate Project v1 roadmap. The canonical near-term implementation order remains in [Product goal and roadmap](./PRODUCT_ROADMAP.md).

The purpose of this document is to preserve architectural direction without turning distant capabilities into present-day prerequisites. These projects may be reordered when real use provides better evidence, and none of them should delay Phase 3D, Phase 4, the v1 feature freeze, systematic frontend refinement, or release hardening unless a concrete data-integrity or operational risk requires earlier work.

## Engineering stance

The application has grown into a system where apparently small features can cross persistence, storage, authorization, export, recovery, and UI boundaries. Several of the long-term projects below would historically have represented months of engineering work. Modern libraries, managed infrastructure, automated verification, and AI-assisted development reduce implementation cost substantially, but they do not remove the need for explicit invariants around data integrity, migration, security, and authorization.

The long-term strategy is therefore:

- keep each major concern behind a clear boundary;
- prefer normalized identities and adapter seams over provider-specific shortcuts;
- make destructive transitions resumable, verifiable, and recoverable;
- avoid implementing speculative multi-user or portability machinery before it is needed;
- preserve enough architectural neutrality that future work remains an extension rather than a rewrite.

## Intended long-term order

The likely order after the Project v1 product shape and frontend refinement is:

1. **Settings & Personalization** as an application-wide product area;
2. **Tiered Large-file Storage & Migration** as a dedicated storage project;
3. **Docker / self-hosted portability** as a separately scheduled deployment milestone;
4. **Multi-user Collaboration & Authorization** as a later shared-data capability, likely after the portable deployment model is understood.

This order is directional rather than contractual. In particular, the storage project may move earlier if long-term real data volume makes later migration unnecessarily risky.

---

## Long-term project A — Settings & Personalization

Settings is an application-level capability, not a Project feature and not a continuation of the Project phase numbering.

### Goal

Replace the current top-level Export-only destination with a coherent Settings area that owns application preferences, storage management entry points, and data-control tools without coupling them to Project internals.

### Candidate areas

#### Appearance and local preferences

- light / dark / system theme selection;
- reviewed palette families built from complete interface token sets;
- density and other presentation preferences where useful;
- default views and non-destructive UI preferences;
- local-first persistence initially, with cross-device preference sync only if a later identity system justifies it.

Workflow semantic colors remain separate from interface palettes. User-selectable palettes must not redefine the meaning of Done, Active, Complete, Warning, Mismatch, destructive actions, or Process-grid states.

#### Data and backup

- the existing complete ZIP export remains available inside Settings;
- human-readable Project export remains a separate presentation/export concern;
- restore remains a privileged and separately designed destructive operation;
- backup/export behavior must not become dependent on optional personalization settings.

#### Storage entry point

Settings may expose storage status, connection management, migration state, and policy controls, but the underlying storage architecture belongs to the dedicated storage project below.

### Boundary

Settings should consume stable storage, export, authentication, and preference APIs. It should not become the owner of blob identity, migration state machines, or authorization semantics.

---

## Long-term project B — Tiered Large-file Storage & Migration

This is a dedicated architecture and data-integrity project. It should not be implemented as a simple provider dropdown.

### Product boundary

Small, derived, and latency-sensitive application objects remain on fast application storage such as R2 or the corresponding server-side equivalent.

Examples include:

- thumbnails and previews;
- derived images;
- small application assets;
- staging/transient objects where appropriate;
- other objects whose fast, predictable retrieval is part of normal UI behavior.

Only **large durable originals** enter the configurable storage layer. Candidate classes include:

- large attachments;
- raw measurement files;
- large Project-owned files;
- source workbooks or datasets when their size/role justifies external storage.

The system therefore does **not** need to make every blob provider-neutral.

### Durable model direction

The long-term model should distinguish the logical large object from one or more physical locations.

Conceptually:

```text
logical attachment
    ↓
large object
    ↓
verified physical location(s)
    ↓
storage profile
    ↓
R2 / SWITCHdrive / WebDAV / future compatible providers
```

Likely persistent concepts include:

- **large object identity** — stable content metadata such as SHA-256 and expected byte size;
- **storage profile identity** — one configured backend/mount with stable identity independent of the provider name;
- **physical location identity** — provider-specific locator plus verification/lifecycle state;
- **storage policy** — which profile receives new large-object writes.

A provider name alone is insufficient identity. Switching from one SWITCHdrive account/root to another must not cause historical objects to be interpreted through the new credentials.

### Migration protocol

Storage changes are not destructive `move` operations. The required direction is:

```text
enumerate
→ copy
→ verify destination
→ register verified destination
→ cut over read/write preference
→ observe / reconcile
→ retire old location
→ GC only after safety checks
```

Migration must be:

- resumable;
- idempotent;
- crash-safe;
- auditable;
- safe under response loss and provider uncertainty;
- able to identify exactly which objects are pending, copied, verified, cut over, or retired.

Destination validation should use the authoritative expected SHA-256 and byte size, provider metadata checks, and full-byte re-hashing when required by the trust boundary. A failed destination verification must not damage the existing source copy.

### Multi-location support

During migration, one logical large object may legitimately have more than one physical copy. The data model should therefore permit multiple verified locations even if the first product UI exposes only one preferred backend.

This also leaves room for later replication/backup policies without redesigning logical attachment identity.

### Secrets

Credentials are server-side secrets. Settings may replace or test credentials, but saved secrets must never be returned to the browser. Storage-profile metadata and credential material should remain separate abstractions.

### Authorization boundary

Physical storage does not own user permissions. The storage layer answers:

> Where are the bytes, and is this copy healthy?

The domain/authorization layer answers:

> Is this user allowed to access the logical attachment that references those bytes?

Changing R2 ↔ external storage must not change who can see or modify the corresponding Sample, Project, Comment, or attachment.

---

## Long-term project C — Docker / self-hosted portability

Docker/self-hosted distribution is a later portability milestone, not a near-term Project requirement.

### Goal

Run the same product contracts outside the current Cloudflare deployment without creating a separate fork or alternative domain model.

### Expected boundaries

A portable deployment should provide equivalents for:

- D1 through ordinary SQLite or another explicitly supported database adapter;
- R2 through local/object-storage adapters;
- managed large-file storage through the same storage-profile/provider contracts;
- authentication and secret storage through deployment-specific adapters;
- scheduled/background operations through explicit runtime boundaries;
- export, restore, configuration, and migration behavior through the same product semantics.

Cloudflare may remain the preferred hosted deployment. Portability means the domain model does not require Cloudflare-specific identity or storage semantics, not that every deployment must provide identical infrastructure internally.

### Relationship to later multi-user work

Understanding authentication, secrets, storage profiles, configuration, and background-operation boundaries in both hosted and self-hosted deployments should make later multi-user authorization easier to design cleanly. For that reason, multi-user remains a likely post-portability project rather than an immediate prerequisite.

---

## Long-term project D — Multi-user Collaboration & Authorization

Multi-user support is a long-term capability and should not be pre-implemented in the current single-user-oriented schema. The immediate product should continue to preserve actor attribution, stable identities, optimistic concurrency, and clean resource boundaries without adding speculative ACL machinery.

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

Logical permission follows the domain resource that references a large object. It does not follow the physical blob location or uploader.

For example:

```text
Sample B
  ↓ attachment
large object
  ↓
SWITCHdrive location
```

If User A cannot read Sample B, A cannot fetch that attachment even though A and B share the same SWITCHdrive storage profile. Moving the object to R2 or another provider must not change that authorization result.

### Export and administration

Multi-user will require at least two distinct export concepts:

- an export of data the current user is authorized to access;
- a privileged full-workspace/system backup.

Full restore and storage migration are administrative operations and require stronger authorization than ordinary research editing.

---

## What should be preserved now

These long-term projects do **not** justify adding speculative multi-user or storage-migration schema during the current Project work.

Current development should simply avoid closing the future path:

- continue recording real actor identity where available;
- keep stable resource and occurrence IDs;
- preserve optimistic concurrency and idempotent operation identity;
- keep logical attachment identity separate from physical storage locators;
- keep storage adapters behind explicit provider/runtime boundaries;
- keep Cloudflare-specific details out of domain contracts where practical;
- avoid assumptions that the creator is permanently the only person allowed to operate a resource;
- avoid assumptions that a blob's physical provider determines its logical ownership or visibility.

Everything beyond those low-cost constraints can wait until its dedicated project begins.

## Non-goals for the near term

The current roadmap should not be expanded to implement:

- user/workspace tables solely for future-proofing;
- per-resource ACLs before multi-user work begins;
- real-time collaboration;
- per-user databases or per-user physical storage stacks;
- arbitrary provider-neutral storage for every small/derived object;
- destructive storage migration without copy-and-verify semantics;
- Docker-specific duplicated domain logic;
- account-level preference synchronization before a real identity requirement exists.

The near-term priority remains completing and refining the single-deployment product. These long-term capabilities should begin only when their product value justifies the additional correctness surface.