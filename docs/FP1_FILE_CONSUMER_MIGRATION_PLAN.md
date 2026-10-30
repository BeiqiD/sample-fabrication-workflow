# FP1g: historical consumers and a read-only File conversion plan

Implementation base: `0e7d3f6` (merged PR #213). The implementation PR records
the reviewed commit, verification results and deployment acceptance.

The immutable legacy inventory records physical-key observations. It cannot
recover every historical consumer from a time-dependent retention view alone.
FP1g adds a complete typed projection and an offline deterministic report. This
prepares the combined File authority transition; it does not execute it or close FP1.

Current handoff: FP1a–FP1j are merged through PR #219 at exact integration head
`7e63a366663c47c830120abc77af1d174abaf5aa`. The
[FP1k additive transition](./FP1_FILE_AUTHORITY_TRANSITION.md) installs migration
`0007` and schema-14 export/recovery, but its authority mode is immutably
`legacy`. It does not turn this read-only report into execution authority.

## Input and command

```bash
npm run plan:file-migration -- --snapshot COMPLETE_V10_SNAPSHOT.json --output NEW_REPORT.json
```

Input is the complete JSON response from the authenticated
`/api/exports/all?archiveSchema=10&archiveWriter=1` endpoint, saved as a fixed file.
It must satisfy schema **10**, writer **1**, `fp1-import-acceptance`, including
tables, blob observations and reviewed schema artifacts. An archive's
`export-manifest.json` is not this input. The command does not read ZIPs, contact
the endpoint or acquire credentials.

After [FP1h](./FP1_DURABLE_R2_UPLOAD_ACCEPTANCE.md), the same command also accepts
complete V11 JSON snapshots (`archiveSchema=11&archiveWriter=1`, profile
`fp1-r2-upload-acceptance`). It preserves V10 admission and adds recorded upload
namespace evidence for V11; neither version can authorize migration execution.
[FP1i](./FP1_METROLOGY_REFERENCE_ACCEPTANCE.md) adds complete V12 input
(`archiveSchema=12&archiveWriter=1`, `fp1-metrology-reference-acceptance`). Its
metrology acceptance history also participates in the fingerprint and explicit
namespace evidence. [FP1j](./FP1_COMMENT_ACCEPTANCE.md) adds complete V13 input
(`archiveSchema=13&archiveWriter=1`, `fp1-comment-acceptance`), including Comment
request/upload history and its frozen namespaces. All four versions remain
read-only plans; recorded purposes do not resolve ambiguous historical consumers.
[FP1k](./FP1_FILE_AUTHORITY_TRANSITION.md) deliberately does **not** add V14 as
planner input. Schema 14 is the post-expansion recovery contract and contains
additive authority-transition state; treating it as a pre-expansion planning
snapshot would blur the captured baseline. The CLI therefore remains bounded to
V10–V13 and must reject V14 explicitly. Schema-14 export is still in immutable
`legacy` authority mode, but it is not an execution-authorizing plan.

Limits are **16 MiB input**, **20,000 aggregate table rows** (including views) and
**8 MiB output**. Changing inputs, non-regular files, invalid UTF-8/JSON and
incompatible contracts are rejected. Output uses mode `0600` and exclusive atomic
publication; an existing report is never replaced. Console output contains raw
input/report SHA-256 values and summary counts. Identifiers and object keys remain
operational metadata and should stay with their corresponding snapshot.

The report's `source.inputSha256` binds the complete canonical snapshot, including
fields omitted from the report. Relational row order and schema object order are
normalized; the export time remains part of the identity. This differs from the
CLI's raw-file digest when formatting or row order differs. Execution time,
current settings, environment and provider discovery do not enter the plan.
Bounds qualify an offline Node command and representative workerd fixtures; they
do not certify maximum-size Cloudflare CPU or memory use.

## Canonical occurrences and classification

Each observation contains its real table, full primary key, actual locator column
and recorded reference value. Unbound file items receive a `pending_content`
diagnostic. Composite IDs remain structured values, even when keys contain colons.

| Table | File slot | Purpose evidence |
|---|---|---|
| `state_representation_assets` | `asset_id`, composite state/asset key | Recorded diagram → embedded content; otherwise unresolved |
| `run_step_assets` | `asset_id` | Known execution/state-observation image role → embedded content |
| `metrology_template_references` | `asset_id` | Historical intent insufficient; unresolved |
| `run_step_comments` | `asset_id` | Legacy Comment image → embedded content |
| `state_verifications` | `evidence_asset_id` | Verification image → embedded content |
| `comment_submission_items` | `asset_id` or `storage_object_id` | Attachment → research source; illustration → embedded content; reciprocal same-submission preview pair → derived preview |
| `events` | `asset_key`, `metadata_json.thumbnailKey` | Recorded Sample image operation → embedded content; distinct thumbnail with primary image → derived preview; otherwise unresolved |
| `imports` | Workbook and manifest keys | Provenance |
| `template_versions` | `source_asset_key` | Provenance |
| `project_content_attachments` | `asset_id` or `storage_object_id` | Upload/copy history does not prove original intent; unresolved |
| `attachment_derivatives` | `derived_asset_id` | Recorded browser-preview kind → derived preview |

Deleted, expired, superseded, pending and failed occurrences remain, with relevant
lifecycle and parent retry metadata. Both slots of a conflicting dual binding
remain visible. Missing registries preserve the original reference value; direct
keys remain locators without a registry. Same-key timeline thumbnails remain
separate observations with an alias diagnostic.

Classification does not substitute MIME, filename, size or equal SHA for operation
semantics. Every observation has `derivationTrust: "not_assessed"`: preview purpose
or a client pair does not authorize a source or certify a trusted derivative.

Each supplied retention edge is matched by locator, source and occurrence, then
checked against registry identity. Unmatched/ambiguous edges remain explicit and
their locators stay in the plan. Consumers without an edge are listed; expiry and
supersession can legitimately cause this absence. Comparison creates no retention
hold and does not certify that a later live database still equals the snapshot.

## Physical groups and proposals

Groups include registries, consumers, direct keys, archive observations,
GC/quarantine and immutable legacy mappings. Expected hashes/sizes remain
historical claims, with missing/conflicting metadata explicit. Unreferenced
registry/GC objects remain visible without invented consumers.

Namespace resolution requires a recorded mapping/location/profile or an accepted
import's frozen profile revision. Defaults, matching provider labels and an
available profile are insufficient. Invalid/conflicting evidence blocks resolution.
Credential-bearing namespace syntax is not emitted as a usable identity. Arbitrary
bodies, filenames, provider errors, download URLs and raw mapping JSON are excluded;
mapping evidence is retained by hash.

Each proven purpose receives a proposed system-scope File ID hashed from namespace,
legacy locator, purpose and scope. Unknown namespace produces no ID. These are
proposals, not published identities or cross-object deduplication decisions.
Multiple purposes on shared physical bytes require independently verified copies
before independent placements publish. Differences from immutable mapping
classification remain reviewable without rewriting that history.

Every report is `executable: false`, `bytesVerified: false`. Every group includes
`bytes_unverified`, so `blockedGroups` includes all groups and does not mean
unexpected errors. Other blockers describe outstanding classification, namespace,
registry, retention, lifecycle and metadata work.

## Qualification and next transition

Focused tests cover historical identity, deterministic snapshot binding, purpose
separation, namespace evidence, incomplete/conflicting metadata, bounds, redaction,
non-regular inputs and concurrent exclusive output. Populated fixtures exercise
the historical migration chain, production V10 export in SQLite and real
workerd/D1, and isolated V10 recovery preserving plan semantics. The native
planning Worker has no provider binding. Mandatory archive/restore regressions
remain; ZIP-specific/browser ZIP acceptance stays deferred at the owner's request.

FP1g itself changes no schema, archive version, HTTP route or UI behavior.
FP1h–FP1j subsequently added accepted ordinary/Project, metrology and Comment
operations without activating File authority. FP1k now adds typed consumer and
conversion substrate, but immutable `legacy` mode keeps the legacy consumers,
global-SHA deduplication, retention and lifecycle rules authoritative.

The next PR must implement the complete shadow writer/resolver and conversion
ledger across every writer and consumer. Execution must re-read and compare the
live baseline, acquire durable holds, fence concurrent changes and record explicit
unresolved outcomes. It must use purpose/scope/profile-aware candidates and
complete-byte verification. When one locator serves more than one purpose, the
resolver must create and verify independent physical placements rather than
aliasing one location across logical Files. A saved FP1g report, an acceptance
receipt or the presence of `0007` cannot authorize publication.

Final cutover is later: after complete ledgered catch-up, a separately reviewed
atomic activation must fence old Workers and switch consumer reads/writes,
deduplication, retention, quarantine, deletion and recovery authority together.
Only then may compatibility retirement be scheduled. R2 defaults for both roles
and authenticated storage Settings follow conversion.
