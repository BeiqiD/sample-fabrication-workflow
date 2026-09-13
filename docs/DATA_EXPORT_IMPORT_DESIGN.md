# Data export, import, and recovery design

Status: proposed target design for review; no implementation or deployment claim.
Last reviewed: 2026-09-13 against integration commit `4e78fa76b727f81b1431b60ff481bd686d83cb4c`.

This design separates three user goals while sharing archive and file machinery.
The [product roadmap](./PRODUCT_ROADMAP.md) owns priority; the
[file/data portability implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md)
owns staged delivery. File identity, purpose, placement, provider instances, and
retention follow the [file storage architecture](./FILE_STORAGE_ARCHITECTURE.md).

## 1. Product goals and entry points

| User goal | Action and entry point | Result and destination behavior |
| --- | --- | --- |
| Read or share research | Export report on a Sample or Project | Offline readable material; no application installation required. |
| Transfer or reuse research | Export data package and Import package | Native records, relationships, and files with a website round trip. |
| Protect or recover an installation | Backup and Restore in Settings → Data | Privileged recovery of canonical business data and eligible configuration. |

A native data package includes a readable report projection. A report can also be
downloaded independently when the user needs presentation without native records.
Full backup is distinct from additive research import: preserving an installation
and adding a copy of a Sample have different identity and activation semantics.

The current Export destination should become the data-control area of Settings.
Contextual Sample/Project export remains available where users select the scope.
Export and import previews show scope, dependencies, file totals, completeness,
and destination behavior before committing an operation.

## 2. Existing behavior and the actual gaps

- [ExportPage](../src/pages/ExportPage.tsx) offers a full system ZIP, described as
  backup, with database rows, available bytes, and archived warnings.
- The [v8 browser writer](../src/lib/exportAll.ts) verifies the negotiated table
  and provenance envelope, checks available blob sizes/hashes, and records final
  outcomes. Its top-level download action does not present returned warning counts
  in the page. A successful ZIP download is therefore not proof of completeness.
- [Sample export](../src/lib/exportSample.ts) already includes `sample.md`,
  `sample.json`, and retrieved images/files. It is a readable page-data projection,
  not a versioned native package with a defined dependency closure and importer.
- [Project readable export](../src/lib/project-readable-export.ts) already includes
  `reading.md`, owned attachments, a summary manifest, and warnings. References
  become excerpts and source links; this format does not preserve the complete
  source graph, Map placements, or edges needed for a portable Project.
- The [isolated recovery utility](./EXPORT_RESTORE_REHEARSAL.md) supports trusted
  v7/v8 archives and qualified local schema targets. It restores rows and available
  bytes into a new local directory. It is not a website import, provider uploader,
  existing-database overwrite command, or completed remote recovery procedure.
- Its bounded ZIP limits and trust model are deliberate. The browser's current
  in-memory ZIP construction and this utility are not the large-file job engine.
- Website FabuBlox workbook import creates process templates; it does not import
  native Sample, Project, or complete-backup archives.

Existing exports and recovery evidence remain useful. This project supplies the
missing product contracts and round trips without describing them as already done.

## 3. Shared archive protocol

Use one versioned archive envelope and shared catalog/validation machinery, with
explicit profiles for `report`, `data_package`, and `system_backup`.
These are not three independently invented archive serializers.

The common manifest declares:

- archive kind, protocol version, package ID, creation time, and scope roots;
- domain schema version and producer compatibility information;
- source installation identity and source entity identities/revisions;
- structured record entries, relationship entries, and their declared hashes;
- logical file entries, purpose, expected size/hash, and archive-relative paths;
- dependency inclusion/exclusion and unresolved-reference outcomes;
- completeness, warnings, and final per-file outcomes;
- optional readable projection and privileged recovery-artifact descriptors.

The public package version is separate from a physical D1/SQLite migration number.
Native records express domain contracts rather than arbitrary database tables or
browser view models. Full backups can add protected table/schema provenance using
the same envelope without making it the ordinary research-transfer format.

Machine-readable records are authoritative for native import. `index.html`,
Markdown, and optional CSV are derived views; editing a report does not silently
edit the native record payload. Shared serializers own identity, graph closure,
file inventories, hashes, paths, and warnings across all profiles.

Do not embed executable schema, SQL import instructions, credentials, expiring
download URLs, or provider addresses as required inputs to native data import.
Checksums establish byte consistency, not authorship or a trusted source identity.
An origin identifier is provenance, not proof that an archive was signed.

## 4. Readable report

The preferred report entry point is an offline `index.html` with a clear title,
table of contents, readable experimental history, and links to packaged files.
Also provide Markdown for reuse. CSV is optional for genuinely tabular data; PDF
can be a later projection of the report renderer rather than a new data protocol.

Sample reports organize runs, observations, measurements, verification, and history.
Project reports preserve the selected Reading order and distinguish owned content
from referenced source records. A Map overview may be included as presentation;
native geometry and edges belong in structured records, not image interpretation.

Use human-readable filenames with collision-safe archive paths. Included records
and files use relative links. Excluded live sources are labelled external links.
The report must remain useful without the original application or provider login.
Missing content has visible placeholders and a readable completeness summary.

HTML is generated from sanitized application renderers. Imported HTML and scripts
are never trusted or executed to recover domain data. Previews of an uploaded
report/package must not execute active content in the application origin.

## 5. Native data-package scope and dependency closure

A package starts with explicit roots: one or more Samples or Projects.
The export planner computes the required dependency closure on the server under
the caller's authorization, not by recursively downloading arbitrary URLs.

| Root or relationship | Required native content |
| --- | --- |
| Sample | Metadata, runs, plan revisions, observations/comments, relevant measurements and verification/history, and their required definitions/files. |
| Project | Owned Markdown/attachments, items, ordering, placements, edges, and reference-target relationships. |
| Project reference | Included source records plus the context/revisions required to reconstruct the reference faithfully, or an explicit unresolved dependency. |
| Shared source or definition | One canonical exported entity reused by all included relationships. |
| File occurrence | Its logical file/representation relation and required packaged bytes, with explicit availability and trust metadata. |

The preview explains when a selected Step or Comment requires additional owning
context. Closure must not silently include unrelated Samples, users, or an entire
workspace merely because a definition or execution context is shared.
The smallest semantically valid closure needs a documented domain rule per root.
If permissions prevent closure, do not expose unauthorized titles or metadata.

The user sees included records, required dependencies, excluded/unavailable sources,
and expected file totals. Export only data that the caller can read; import checks
the destination capabilities needed to create those records and relationships.
Full-workspace backup permissions do not follow from ordinary Sample edit access.

References remain references after import. Import creates or explicitly maps source
records, then rewrites target IDs, occurrences, placements, and edges consistently.
It must not convert source records into Project-owned Markdown to avoid this work.
Missing dependencies retain explicit unresolved state and provenance. A report
with live links alone must not be labelled a self-contained native data package.

## 6. Native import identity and conflicts

V1 imports research as a new copy with fresh destination entity IDs and preserved
source installation/entity/revision provenance. Copying a record does not assert
that its historical actor is a current destination account or grant permissions.

An import ledger records package identity, content digest, destination scope,
operation ID, identity mappings, and durable progress. Retrying the same operation
resumes or returns its committed result instead of creating duplicate entities.
Repeated import of an already completed identical package reports the existing
result; an explicit “Import another copy” starts a distinct operation.

Do not match records by filename, Sample code, title, or file hash. Do not overwrite
existing research or perform a general merge by default. Display naming conflicts
and the destination policy before import. Future explicit reuse of existing
records must verify origin and compatible revision under current authorization.

Byte reuse and record reuse are separate decisions. Reuse requires the same access
scope, purpose, and resolved destination profile plus verified bytes and retention
eligibility. It must not merge distinct occurrences, captions, histories, or trust.

## 7. File purpose and destination mapping

Package records retain file purpose independently of extension, size, and provider.
The initial policy mapping follows the shared file architecture:

| File purpose | Default placement role |
| --- | --- |
| `research_source` | `originals` |
| `provenance` | `originals` |
| `embedded_content` | `internal` |
| `derived_preview` | `internal` |
| `job_output` | `internal`, with explicit generated-output retention |

On import or restore, resolve those roles to the destination's configured provider
instances. For example, internal media can go to Local while originals go to
SWITCHdrive, regardless of where the source deployment kept them.
Logical identity and archive-relative paths are sufficient to reconstruct data;
old storage locators are optional protected provenance, not destination addresses.

Source bytes, representations, and physical copies remain distinct. A missing
original is never replaced by a thumbnail or silently recompressed image.
A preview may be regenerated only where a real supported producer, source bytes,
and recorded transformation/trust contract exist. Do not assume every derived
file is safely disposable or every image is a derivative.

An untrusted package can preserve a preview's purpose and displayable bytes, but
its generator/source claims remain imported-unverified provenance. A valid hash
does not prove the claimed transformation or admit a shared trusted derivative.
Local verified generation or a separately qualified trusted recovery path is
required for that promotion. Preserve unresolved claims without fabricating a
verified relationship; do not discard imported previews as reproducible caches
on the strength of the package's own assertions.

## 8. Completeness and failure behavior

| Result | Required user-visible behavior |
| --- | --- |
| Complete native package | Every mandatory record/dependency and promised required file is present and verified. |
| Partial package | Explicit missing/excluded inventory; no claim of a complete round trip. |
| Complete backup | All required canonical data and promised required bytes are preserved and verified. |
| Partial backup | Keep useful recovered data, but display missing counts, affected records, and limitations directly in Settings. |
| Report with unavailable media | Open the readable report with visible omissions and warning summary. |

Separate provider unavailable, missing, metadata not ready, retrieval failure,
size mismatch, and hash mismatch. A ZIP creation success does not collapse these
outcomes into “Backup complete.” Offer retry of failed retrievals where applicable.

Native import defaults to requiring its declared mandatory payload. Partial salvage
is an explicit supported mode with unavailable-file/unresolved-reference records,
not silent omission or invented replacement bytes. Unavailable placeholders do not
qualify as published ready Files. Unsupported partial states block publication while
preserving the validated upload for correction or retry.

## 9. Consistent snapshots and durable jobs

Freeze the source record snapshot, dependency graph, revisions, and blob manifest
as one logically consistent export plan. Do not rebuild different portions from
live mutable pages as the download progresses. Record the actual snapshot contract
without inventing an exact database-clock timestamp.

Create retention holds for required files/locations while export or restore reads
them. Migration and GC must honor these holds. Files are immutable; user replacement
creates a new logical version, leaving the frozen export plan stable.

Use the FP3 durable job foundation for bounded reading, verification, archive output,
and import staging. Persist progress, retries, ownership leases, cancellation, and
final outcomes. Closing the browser must not erase an accepted operation.
Generated archives are expiring job outputs with authorized download and cleanup.

Stream or chunk data with bounded memory. Define and verify actual Worker limits,
multipart/range capabilities, timeout behavior, and supported archive sizes per
runtime. Server and Cloudflare adapters may execute jobs differently; a single
unbounded request, whole-buffer ZIP, or assumed resumable ZIP stream is insufficient.
If a provider/runtime lacks a required transfer capability, expose the supported
limit or unavailable operation before starting; do not promise universal large-file support.

Import validates and stages files before publishing business records. Use a durable
pending visibility boundary and bounded commits, followed by verified publication.
There is no transaction spanning the database and every object store. Lost responses,
partial uploads, crashes, and publication retries require reconciliation and retention
rules. Cleanup may collect failed staging bytes only when no published record or hold
needs them. A failed operation must not expose a half-imported research graph.

## 10. Full backup and administrative restore

Full backup preserves canonical business states, identities, relationships, history,
recoverable deletion states, and required bytes. Internal views/caches may be rebuilt
only under an explicit reconstruction contract. Distinguish a backup of recoverable
data from a policy that intentionally excludes old/deleted content.

Eligible system configuration belongs only in a privileged backup profile.
Secrets require a separately protected recovery mechanism and key-recovery plan;
a portable research package never carries reusable connection credentials.
Restored settings do not automatically enable old jobs, webhook destinations,
integrations, credentials, or background cleanup. Review destination configuration
and pending operations before resuming execution.

Exclude the current job's own output and disposable unreferenced staging/output
from backup inventory. A prior generated report or archive protected by a durable
business reference is required content: include it once as opaque file bytes,
without recursively expanding its archive members. Preserve relevant audit
outcomes without treating unfinished transfer state as an instruction to restart
external writes after restoration.

The target website restore flow is validate → stage a fresh recovery target →
verify data/files/configuration → show recovery report → explicit administrative
cutover. Routine package import must never trigger whole-system replacement.
Fresh-target support and activation must be implemented per deployment; this design
does not claim an existing web restore or a safe arbitrary live-database overwrite.

Recovery verifies identity/row relationships, foreign keys, lifecycle/retention,
expected files, hashes, and readable Sample/Project behavior before activation.
Destination role/provider mapping must support recovery to a different deployment.
Preserve an independent recovery path when the normal application cannot start.

## 11. Archive admission and legacy compatibility

Web import is an untrusted-data boundary. Validate kind/version, exact inventories,
domain shapes, relationships, duplicate identities, hashes, member paths, compressed
and expanded limits, counts, and supported compression before publication.
Reject traversal, path collisions, symlink entries, undeclared payloads, and unsafe
archive features. Bound parsing/decompression as well as final extracted size.
Archive-provided SQL is evidence only and never executed; imported HTML cannot
authorize or reconstruct records. Do not fetch arbitrary embedded URLs as import data.

Preserve pinned v7/v8 offline recovery tests and known archive fixtures. New schema
support requires an explicit versioned converter and qualification; old backups must
not silently inherit new field meanings. Existing recovery provenance remains intact.
The [v8 protocol](./FULL_EXPORT_V8.md) remains its historical/current contract until
a successor is implemented. Native website acceptance of old backups is not claimed.

## 12. Delivery and acceptance

- **FP0:** approve this design, the file architecture, and the implementation plan.
- **FP1:** universal file identities/locations, Registry, deployment defaults, and
  basic Settings establish the file-resolution contract consumed by export.
- **FP2:** external configuration, S3, administration, and secret handling establish
  the destination configuration and privilege boundaries.
- **FP3:** durable jobs and all-file migration supply transfer, verification,
  retention holds, and recovery mechanisms used here.
- **FP4:** deliver native package export and matching website import together with
  readable reports; prove Sample/Project closure and cross-provider round trips.
- **FP5:** extend full backup and administrative web restore, including partial
  outcomes, configuration/key recovery, fresh-target verification, and cutover.

Docker delivery remains later. Earlier gates must cover corrupt/partial archives,
duplicate retries, copy identity, missing references, unauthorized dependencies,
concurrent edits/GC/migration, unavailable providers, and restored readable behavior.
Do not mark a milestone complete from an empty archive or schema-only rehearsal.
