# FP2 fresh acceptance storage role selection

New active binary ingestion resolves File purpose through a shared storage-role
selector before accepting provider work. The current immutable policy still
selects the admitted bootstrap R2 profile for both roles. This prepares the
ingress boundary for later independent defaults without activating an external
provider or changing native schema and archive formats.

## Purpose and ingress

| File purpose | Storage role | Current ingress |
| --- | --- | --- |
| `research_source` | `originals` | Project attachments, metrology references, original Comment attachments |
| `provenance` | `originals` | FabuBlox workbook and manifest |
| `embedded_content` | `internal` | Ordinary images, Comment illustrations, FabuBlox images |
| `derived_preview` | `internal` | Comment images representing an original attachment |
| `job_output` | `internal` | Reserved mapping; this slice adds no job runner |

The selector rejects unknown or unselected purposes. Its preparation reads the
recorded role defaults, validates the configured physical R2 namespace and
requires active File authority, enabled execution and profile write admission.
Missing defaults are prepared for initialization; the caller commits both roles
and its business acceptance in one D1 batch. A failed acceptance rolls back the
default rows. A mode change during fresh acceptance fails before provider I/O.
Read-only Settings requests and link-only Comments do not initialize defaults.

Metrology reuse planning uses the selected profile. Comment items retain their
individual purpose and selected profile. FabuBlox currently records one profile
for its complete accepted import, so workbook/manifest and image purposes must
resolve to the same profile and revision. Divergent role targets fail closed
before import acceptance; supporting such imports requires per-item accepted
targets in a later paired native/archive change.

## Accepted history and compatibility

Existing operation identity is checked before consulting current selection.
Accepted retries, publication, reads and cleanup continue from the recorded
profile, revision and candidate identity. Selection never runs per image during
execution and never retargets historical SWITCHdrive or R2 receipts.

The historical `storage_policy_revision = 1` remains an acceptance-format field.
Comments retain their existing additive `storage_role_policy_revision = 2` for
active binary acceptance. The immutable role-default records retain policy
revision `2`; no new revision or activation record is introduced here. Native
guards, the V19 table catalog and schema fingerprint remain unchanged. V7–V19
isolated recovery retains its current behavior and execution starts paused.

Independent mutable defaults, S3 activation and provider account-scope
qualification remain separate work. They require the corresponding runtime,
accepted-policy evidence and successor archive/recovery support; this shared
selection entry point does not establish those capabilities.

## Qualification

Qualification covers all purpose mappings, whole-import destination consistency,
atomic initialization and rollback, mode changes, unavailable selected roles,
same-operation races and replay from frozen receipts. Existing native D1
acceptance and content-schema/recovery checks remain part of verification.
The accepted FP1 live original-file round trip and V19 recovery are retained;
this code-only selection preparation does not require another live ZIP rehearsal.
