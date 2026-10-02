# FP1 R2 role defaults

Implemented and deployed in #238, integration commit `15a9a613`, Worker version
`5f6cc034-ef6e-4ad4-adea-66f3d435239b`. File authority remains Active and execution
Enabled after the explicit 2026-09-30 operator command. The original-file download
repair in #240 (`7504aec`) deployed as Worker
`aa6004ee-3af1-4aaa-8f01-1d541cd65efa`. The 2026-10-01 live R2 original round trip
and isolated V19 recovery passed, closing FP1 live acceptance.

## New writes and accepted history

The Cloudflare bootstrap uses the existing bound R2 profile for both `internal`
and `originals`. Migration `0013` adds `storage_role_defaults`, with one row per
role and the exact profile ID, configuration revision, policy revision and
creation time. The first new active Comment acceptance containing binary items
initializes both defaults in its business transaction. Existing defaults are
read back and never reset by a restart, retry or deployment. Read-only Settings
and storage-status requests do not create profiles or defaults.

The subsequent [FP2 shared selection entry point](./FP2_STORAGE_ROLE_SELECTION.md)
extends this same atomic initialization to other fresh active binary ingress.
Both roles retain the existing R2 destination and policy revision.

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

## Live acceptance — 2026-10-01

The deployed original-file endpoint returned `fp1-r2-original-6MiB.bin` through
an actual authenticated HTTP download after #240. Its 6,291,456 bytes matched the
upload fixture exactly. SHA-256:
`e338caefa380bafe02a98dac6b2865a8c4783d80f5d813906abd01c250463d70`.
This qualifies the complete R2 upload/read path rather than a manifest or
synthetic browser download.

The live `sample-log-2026-10-01.zip`, exported at
`2026-10-01T14:09:23.702Z`, is V19, writer `1`, profile
`fp1-r2-role-defaults`. Archive SHA-256:
`88353faeec219bcb98809f88b5dd11a268234869495368b9b06e6f13dae81994`.
Its isolated recovery passed at `2026-10-01T14:58:46.137Z`:

| Check | Result |
| --- | --- |
| Packaged and recovered byte entries | 15/15, zero warnings; every archived and restored byte matched |
| Large original | Both packaged 6 MiB entries matched the upload/download SHA-256 |
| Canonical database | 73 base tables / 339 rows; equal rows and schema, valid foreign keys, integrity `ok` |
| Rebuilt state | 77 tables and 663 reinstalled triggers; derived state and Project relations passed |
| Recovery admission | Archived authority retained as `active`; File and Shadow guards remained `enabled=0`, `incarnation=null` |
| Provider and system boundary | No provider I/O or resumed operations; zero system storage objects restored |

This closes the changed R2-original and V19 recovery acceptance. It does not
qualify historical SWITCHdrive connectivity or FP2 provider activation. Preserve
this result and the earlier accepted V17/V18 archives; routine FP2 feature work
does not require another live ZIP rehearsal.
