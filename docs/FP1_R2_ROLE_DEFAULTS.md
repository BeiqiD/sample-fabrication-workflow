# FP1 R2 role defaults

Implemented and deployed in #238, integration commit `15a9a613`, Worker version
`5f6cc034-ef6e-4ad4-adea-66f3d435239b`. File authority remains Active and execution
Enabled after the explicit 2026-09-30 operator command. Required CI and deployment
passed. Live original-file and V19 recovery acceptance remains pending because
the acceptance browser service timed out, including its reset operation. The
earlier activation and V18 acceptance do not qualify these changed paths.

## New writes and accepted history

The Cloudflare bootstrap uses the existing bound R2 profile for both `internal`
and `originals`. Migration `0013` adds `storage_role_defaults`, with one row per
role and the exact profile ID, configuration revision, policy revision and
creation time. The first new active Comment acceptance containing binary items
initializes both defaults in its business transaction. Existing defaults are
read back and never reset by a restart, retry or deployment. Read-only Settings
and storage-status requests do not create profiles or defaults.

The bootstrap requires the existing R2 profile to match the configured physical
namespace and already have File write admission. It does not grant that admission
to a different or read-only profile. Before initialization, metadata can describe
the pending R2 bootstrap; an available admitted profile permits the first upload.

Original Comment files use `research_source` purpose and retain their unchanged
bytes, filenames and MIME metadata. R2 accepts originals up to 100 MiB through
the existing streaming verified writer. Processed images and client previews
remain limited to 5 MiB. Original and preview publication still belongs to the
same accepted Comment protocol, including cancellation and required TIFF-original
relationships.

An existing submission is looked up before selecting defaults. Its accepted
items retain their recorded profile and candidate across deployment or retries;
an old SWITCHdrive operation is not redirected to R2. Reads and exports continue
to use each File's recorded location. Changing new-write policy does not migrate
historical files or prove SWITCHdrive connectivity.

## Native and archive boundary

The historical `storage_policy_revision = 1` remains the frozen Comment
acceptance-format field. The additive `storage_role_policy_revision` distinguishes
the historical role policy (`1`) from new active role defaults (`2`). Historical
rows retain their values. Native guards freeze the new field and verify that
new role-policy receipts match the persisted defaults before accepting or
publishing their candidates.

V19, profile `fp1-r2-role-defaults`, pairs this schema with snapshot validation
and isolated recovery. V7–V18 schemas and validators remain frozen. V19 validates
both stored defaults and the accepted role/profile evidence, including old
SWITCHdrive receipts alongside new R2 originals. Restore retains the defaults
but leaves installation execution disabled; no file upload or cleanup is resumed
by reading an archive.

The isolated recovery tool allows a single ZIP entry up to 128 MiB and a ZIP or
total expanded package up to 256 MiB, so one supported 100 MiB original is not
rejected by the former 64 MiB entry limit. These remain bounded local-tool limits,
not a claim that every arbitrarily large whole-system backup fits in this tool.

## Availability and configuration

Storage Settings reports the selected role destinations and registered profile
matches without checking providers or changing configuration. Comment's storage
status checks its current original-file role; an unavailable historical
SWITCHdrive configuration does not disable healthy new R2 originals. Core
readiness checks the database so that reads and Settings remain reachable when
an optional file provider or recovered execution is unavailable. A failing
selected destination is reported unavailable and does not fall back elsewhere.

The deployment continues to keep runtime configuration in Cloudflare. Wrangler's
existing `keep_vars: true` preserves Dashboard-managed variables. Actual emails,
provider-account values and credentials are not copied into repository config;
passwords and tokens remain Secrets. Editable profiles/defaults, configuration
tests, encrypted-secret administration and external S3 belong to FP2.

## Qualification

Focused qualification covers atomic two-role initialization, immutable accepted
destinations, R2 originals above 5 MiB, unchanged streamed bytes, File-based
attachment export, role-aware availability and V19 recovery with execution
disabled. The already accepted V18 ZIP is not rechecked. A single relevant live
acceptance qualifies the changed original-file and successor archive behavior
after deployment.
