from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


# Keep the existing permanent blob-lifecycle status as the single storage safety
# gate; storage integrity is part of that contract rather than a parallel gate.
replace_once(
    "package.json",
    '"verify:blob-lifecycle": "npm run test:blob-lifecycle && npm run verify:d1-migrations"',
    '"verify:blob-lifecycle": "npm run test:blob-lifecycle && npm run test:storage-integrity && npm run verify:d1-migrations"',
)

plan = "docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md"
replace_once(
    plan,
    "Last reviewed: 2026-08-09 after the reference/search and reusable Project\ndiscovery foundation through PR #130",
    "Last reviewed: 2026-08-14 after provider-verified storage integrity and\nProject Markdown lifecycle wiring",
)
replace_once(
    plan,
    "10. migration compatibility repairs for malformed historical event metadata and\n    legacy managed-object duplicate states.",
    "10. migration compatibility repairs for malformed historical event metadata and\n    legacy managed-object duplicate states;\n11. provider `HEAD`/`stat` verification before content-addressed reuse, with\n    terminal integrity quarantine for definite absence or size mismatch.",
)
replace_once(plan, "- provider-stat-based deduplication repair;\n", "")
replace_once(
    plan,
    "The implementation relies on four ordered migration positions around the\nexisting source-lifecycle work:",
    "The implementation relies on five ordered migration positions around the\nexisting source-lifecycle work:",
)
replace_once(
    plan,
    "0017_blob_lifecycle_review_fixes.sql\n```",
    "0017_blob_lifecycle_review_fixes.sql\n0024_blob_integrity_quarantine.sql\n```",
)
replace_once(
    plan,
    "- keep the custom live-SHA constraint compatible with concurrent winner\n  recovery.\n\n## Authoritative schema surfaces",
    "- keep the custom live-SHA constraint compatible with concurrent winner\n  recovery.\n\n### `0024_blob_integrity_quarantine.sql`\n\nThis migration adds `blob_integrity_quarantine` as a terminal record of definite\nphysical-locator failure. A locator enters quarantine only after the provider\nconfirms absence or reports a byte-size mismatch. Authentication, transport, and\nprovider errors do not quarantine metadata.\n\nQuarantine preserves historical metadata and existing relationships for audit,\nexport, and repair, while:\n\n- excluding the locator from future deduplication reuse and live attachment\n  delivery;\n- rejecting new relationships to the locator at the SQL boundary;\n- releasing the content hash so identical bytes can be registered at a fresh\n  physical locator;\n- keeping the old locator terminal rather than silently reusing a recycled key.\n\n## Authoritative schema surfaces",
)
replace_once(
    plan,
    "- `blob_gc_ledger` is authoritative for cross-provider GC state.\n\nA collected R2 asset keeps its content hash and metadata.",
    "- `blob_gc_ledger` is authoritative for cross-provider GC state.\n- `blob_integrity_quarantine` is authoritative for definite provider-byte\n  absence or size mismatch discovered during reuse verification.\n\nA collected or quarantined R2 asset keeps its content hash and metadata.",
)
replace_once(
    plan,
    "  storage.ts\n  permanent-delete.ts",
    "  storage.ts\n  reuse.ts\n  permanent-delete.ts",
)
replace_once(
    plan,
    "### `storage.ts`\n\nNormalizes provider retrieval and removal, distinguishing:\n\n```text\navailable\nmissing\nprovider_unavailable\n```\n\nA provider `HEAD`/`stat` probe before every deduplication reuse is explicitly\ndeferred to a later storage-integrity slice.\n\n### `export.ts`",
    "### `storage.ts`\n\nNormalizes provider retrieval, metadata-only `HEAD`/`stat`, and removal,\ndistinguishing:\n\n```text\navailable\nmissing\nprovider_unavailable\n```\n\nProvider unavailability is never reinterpreted as physical absence.\n\n### `reuse.ts`\n\nOwns provider-verified content-addressed reuse for R2 and managed storage. It\nchecks byte existence and size before releasing an orphan or returning a winner,\nrecords definite failures in `blob_integrity_quarantine`, and surfaces temporary\nprovider failures as retryable service errors without changing metadata.\n\n### `export.ts`",
)
replace_once(
    plan,
    "Every relationship write is protected at the authoritative SQL boundary:\n\n1. source/occurrence must still be writable;\n2. blob metadata must be ready;\n3. locator must not be `deleting` or `deleted`;\n4. edge write succeeds;\n5. an unclaimed `orphaned` row is released atomically.\n\nContent-addressed winner recovery handles concurrent live-SHA registration\nwithout returning a spurious server error.",
    "Every content-addressed reuse and relationship write is protected at the\nauthoritative boundaries:\n\n1. a candidate locator must not be `deleting`, `deleted`, or quarantined;\n2. R2 `HEAD` or managed-storage `stat` must confirm that bytes exist;\n3. a definite provider byte-size must match registered metadata;\n4. provider/auth/transport failure returns a retryable service error and leaves\n   metadata unchanged;\n5. source/occurrence and blob metadata must still be writable and ready;\n6. the relationship write succeeds;\n7. an unclaimed `orphaned` row is released atomically.\n\nA definite missing or size-mismatched candidate is quarantined and skipped. The\nupload then registers the same bytes at a fresh locator. Content-addressed winner\nrecovery still handles concurrent registration without returning a spurious\nserver error.",
)
replace_once(
    plan,
    "The server returns schema v3:",
    "The current complete export returns schema v5:",
)
replace_once(
    plan,
    "all table/view snapshots\n+ one deduplicated blob plan",
    "all table/view snapshots, including integrity quarantine\n+ one deduplicated blob plan",
)
replace_once(
    plan,
    "worker/blob-lifecycle-legacy-managed-migration.test.ts\n```",
    "worker/blob-lifecycle-legacy-managed-migration.test.ts\nworker/blob-integrity.test.ts\nworker/switchdrive-storage.test.ts\n```",
)
replace_once(
    plan,
    "- D1's 100-binding limit.\n\nRepository commands are:",
    "- D1's 100-binding limit;\n- R2 and SWITCHdrive metadata-only verification;\n- missing and size-mismatched quarantine;\n- provider-outage fail-closed behavior;\n- fresh-locator registration after a quarantined winner.\n\nRepository commands are:",
)
replace_once(
    plan,
    "npm run verify:blob-lifecycle\nnpm run verify:v3-deployment",
    "npm run verify:blob-lifecycle\nnpm run verify:storage-integrity\nnpm run verify:v3-deployment",
)
replace_once(
    plan,
    "- provider `HEAD`/`stat` and missing-byte self-healing before dedup reuse;\n",
    "",
)
replace_once(
    plan,
    "The blob-lifecycle slice completed in PR #123, and PR #124 corrected its\nD1/workerd migration compatibility. Feature-branch success still does not\nauthorize a remote operation: the exact merged integration head must pass the\nfull deployment gate.\n\nReference identity, navigation, deterministic search, and the reusable Project",
    "The blob-lifecycle slice completed in PR #123, and PR #124 corrected its\nD1/workerd migration compatibility. The storage-integrity maintenance slice now\nextends that foundation with provider-verified reuse and terminal quarantine.\nFeature-branch success still does not authorize a remote operation: the exact\nmerged integration head must pass the full deployment gate.\n\nReference identity, navigation, deterministic search, and the reusable Project",
)

operations = "docs/BLOB_LIFECYCLE_OPERATIONS.md"
replace_once(
    operations,
    "Last reviewed: 2026-08-09 after the reference/search and reusable Project\ndiscovery foundation through PR #130",
    "Last reviewed: 2026-08-14 after provider-verified storage integrity and\nProject Markdown lifecycle wiring",
)
replace_once(
    operations,
    "The implementation has three different kinds of truth. They must not be\ncollapsed into one status flag.",
    "The implementation has four different kinds of truth. They must not be\ncollapsed into one status flag.",
)
replace_once(
    operations,
    "`managed_storage_objects.status` remains a compatibility projection during this\nslice. The ledger is authoritative when the two are interpreted for GC.\n\n## Terminal locator rule",
    "`managed_storage_objects.status` remains a compatibility projection during this\nslice. The ledger is authoritative when the two are interpreted for GC.\n\n### Integrity quarantine\n\n`blob_integrity_quarantine` records a definite provider-level absence or byte-size\nmismatch found while considering a content-addressed reuse candidate. It is not a\nGC state and does not erase historical metadata or existing relationships.\n\nA provider/authentication/transport failure must never create a quarantine row.\nThe operation fails with a retryable service response and leaves metadata,\nretention edges, and ledger state unchanged.\n\n## Terminal locator rule",
)
replace_once(
    operations,
    "### Managed compatibility projection mismatches",
    "### Integrity quarantine\n\n```sql\nSELECT store_kind, provider, object_key, blob_record_id, reason,\n       expected_byte_size, observed_byte_size, detected_at, last_checked_at\nFROM blob_integrity_quarantine\nORDER BY detected_at DESC\nLIMIT 100;\n```\n\nEach row requires investigation or restoration at a new locator. Do not delete a\nrow merely to make the original locator reusable.\n\n### Managed compatibility projection mismatches",
)
replace_once(
    operations,
    "### Reachable metadata but missing bytes\n\nTreat this as an integrity incident, not as deletion authorization.\n\n- Preserve the source, occurrence, blob metadata, and export warning.\n- Check provider history, credentials, retention, and external backups.\n- Do not remove the retention edge to make the warning disappear.\n- Restore by registering verified bytes at a new locator unless an explicit\n  integrity-repair procedure is introduced later.",
    "### Reachable metadata but missing bytes\n\nTreat this as an integrity incident, not as deletion authorization. A definite\nmissing or size-mismatched candidate discovered during deduplication is recorded\nin `blob_integrity_quarantine` and is not returned as a reusable winner.\n\n- Preserve the source, occurrence, blob metadata, quarantine row, and export\n  warning.\n- Check provider history, credentials, retention, and external backups.\n- Do not remove a retention edge or quarantine row to make the warning disappear.\n- Restore by registering verified bytes at a new locator and explicitly repairing\n  affected relationships through a reviewed procedure.",
)
replace_once(
    operations,
    "### Provider unavailable\n\n- Keep the ledger/source state unchanged except for the recorded retryable\n  cleanup error.\n- Verify credentials and provider health.\n- Re-run the normal scheduled/idempotent operation after recovery.\n- Do not mark the object missing solely because authentication or transport\n  failed.",
    "### Provider unavailable\n\n- Keep the ledger/source state unchanged except for any ordinary retryable cleanup\n  error.\n- Deduplication reuse returns a retryable service error and creates no integrity\n  quarantine row.\n- Verify credentials and provider health.\n- Re-run the normal scheduled/idempotent operation after recovery.\n- Do not mark the object missing solely because authentication or transport\n  failed.",
)
replace_once(
    operations,
    "### Provider `HEAD`/`stat` before dedup reuse\n\nThe first implementation excludes locators claimed or finalized by the GC\nledger, but it does not probe the provider before every deduplication reuse. A\nready metadata row whose bytes drifted missing may therefore be selected and\nwill fail later retrieval/export.\n\nCurrent behavior is safe for retention: the database history remains intact and\nexport emits a warning. A later storage-integrity slice may add `head/stat`,\nquarantine unavailable metadata, and upload/register a replacement locator.\n\n### Direct-key physical garbage collection",
    "### Quarantine revalidation and relationship repair\n\nThe current implementation deliberately treats definite missing and size-mismatch\nquarantine as terminal for the old physical locator. It does not automatically\nclear quarantine when bytes later reappear at the same key, because that could\nsilently bind historical metadata to different bytes.\n\nA future privileged repair workflow may verify restored content, register a new\nlocator, and rebind affected relationships with explicit audit records. Until\nthen, restoration uses a fresh locator and reviewed data repair.\n\n### Direct-key physical garbage collection",
)
replace_once(
    operations,
    "Reference identity, deep links, exact focus, deterministic search, and the\nreusable Project discovery surface were completed after this operational\nfoundation, through PR #130.",
    "Reference identity, deep links, exact focus, deterministic search, and the\nreusable Project discovery surface were completed after this operational\nfoundation, through PR #130. Provider-verified reuse and integrity quarantine are\nnow part of the same permanent blob-lifecycle gate.",
)

roadmap = "docs/PRODUCT_ROADMAP.md"
replace_once(
    roadmap,
    "Last reviewed: 2026-08-13 after the reference/search foundation through PR #130,\nPhase 3A1/3A2 Project persistence in PRs #131/#132, the Map kernel in PR #133,\nreference placement in PR #134, and Project-owned content in PR #135 were\ncompleted; Phase 3B4 basic Project-local edges are complete in squash-merged PR #136,\nand Phase 3C Reading projection is complete in squash-merged PR #138",
    "Last reviewed: 2026-08-14 after the reference/search foundation through PR #130,\nPhase 3A1/3A2 Project persistence in PRs #131/#132, the Map kernel in PR #133,\nreference placement in PR #134, Project-owned content in PR #135, edges in PR\n#136, Reading in PR #138, and Project Map stabilization through PR #140",
)
replace_once(
    roadmap,
    "- shared blob reachability, GC ledger, export integrity, and physical-delete\n  protection;",
    "- shared blob reachability, GC ledger, export integrity, physical-delete\n  protection, and provider-verified deduplication with integrity quarantine;",
)
replace_once(
    roadmap,
    "Phase 3B3 Project-owned Markdown and generic attachment creation is complete in\nsquash-merged PR #135. Phase 3B4 basic Project-local edges are complete in\nsquash-merged PR #136. Phase 3C Reading projection is the active implementation\ntarget.",
    "Phase 3B3 Project-owned Markdown and generic attachment creation is complete in\nsquash-merged PR #135. Phase 3B4 basic Project-local edges are complete in\nsquash-merged PR #136. Phase 3C Reading projection is complete in squash-merged\nPR #138. Phase 3D Markdown/TeX, media, and save UX hardening is the active\nimplementation target; storage-integrity work remains a parallel quality track.",
)
replace_once(
    roadmap,
    "### Phase 3C — Reading projection\n\n**Status:** active implementation.",
    "### Phase 3C — Reading projection\n\n**Status:** complete; squash-merged in PR #138, with Markdown removal lifecycle\nwiring completed in the subsequent storage-integrity maintenance slice.",
)
replace_once(
    roadmap,
    "- edit existing Project-owned Markdown;\n- edit attachment caption",
    "- edit and recoverably remove existing Project-owned Markdown;\n- edit attachment caption",
)
replace_once(
    roadmap,
    "### Phase 3D — Markdown/TeX, media, and save UX hardening\n\n**Goal:**",
    "### Phase 3D — Markdown/TeX, media, and save UX hardening\n\n**Status:** active implementation.\n\n**Goal:**",
)
replace_once(
    roadmap,
    "- complete export integrity;\n- no physical locator exposure;",
    "- complete export integrity;\n- provider-verified content-addressed reuse with fail-closed outage behavior;\n- no physical locator exposure;",
)
