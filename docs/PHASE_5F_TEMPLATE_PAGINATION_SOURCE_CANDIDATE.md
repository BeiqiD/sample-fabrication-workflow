# Genuine Templates default-pagination qualification plan

Historical frozen source snapshot. The later actual outcome is recorded in
[Templates pagination qualification](PHASE_5F_TEMPLATE_PAGINATION_QUALIFICATION.md).

Date: 2026-10-10 UTC. Status: **source-prepared and entirely UNRUN**. The two
additive helpers have not been syntax-checked, bundled, seeded or executed.
This checkpoint changes QA/documentation only and preserves the earlier six
directory/Project scenarios, historical mixed matrices and their receipts.

The remaining concrete gap is both Templates directories crossing their real
default page sizes with distinct families. Twenty-one versions of one process
family would not exercise that gap. The new isolated fixture therefore needs
**21 process families** and **26 metrology families**, each with version 1.

## Ordinary creation and exact original inputs

`seed-template-pagination-actual-api.mjs` uses the original process import flow:
the actual `src/lib/fabublox.ts` parser reads valid synthetic OOXML XLSX files,
then the helper submits the resulting schema-version-2 manifest and workbook
through `POST /api/imports/fabublox` with its genuine UUID
`X-Import-Request-Id`. There is no process `POST /templates` route. The fixture
parser is bundled with the existing pinned esbuild/JSZip and mature DOMParser
shim; this is explicitly fixture preparation, not a browser parser result or
an application build. Each workbook has Step 0 `Substrate Stack` and one
executable `Coat` step, with no images.

The original import client sends a null family ID for a new family, but the
service can still find an existing process family by its trimmed title.
All 21 titles are therefore unique. The real directory reads must prove
21 distinct accepted family IDs, matching template IDs and version 1, rather
than relying on the number of POSTs. Every import must return 201; its ordinary
accepted-request GET must return the exact ready result.

Metrology uses ordinary `POST /api/metrology-templates` with the original four
string fields: `name`, `toolName`, `parametersText`, `commentsText`. Names are
unique, nonempty and within the original limits. Each create must return 201
and version 1. Its actual detail GET proves the distinct family ID, metrology
kind and original one-step content. The 47 family and template IDs must all be
distinct across both domains.

No role or File-authority state is injected through SQL. The original import
service resolves its actual active-authority/default-role state and performs
ordinary local R2 workbook/manifest write, verification and publication.
The generic synthetic SQL stage prepares only the mature random two-version
sentinel; it does not create the 47 new pagination owners.

Before a mutation is dispatched, the helper appends its original input and
origin/import-request header to a private journal. Exact original workbook and
transport-manifest bytes are saved separately. Unknown outcomes are retained;
there is no automatic retry, new request identity, owner deletion or reuse of
a partially attempted fixture. The final receipt hashes the original journal.

## Finite actual request and browser scope

The seeder has **102 expected ordinary API requests**:

| Purpose | Requests |
| --- | ---: |
| Two original random template sentinel reads | 2 |
| Both fresh query namespaces empty before create | 2 |
| Process imports and exact accepted-request reads | 21 + 21 |
| Metrology creates and genuine template-detail reads | 26 + 26 |
| Each directory's default first and last pages | 4 |

The final reads omit `pageSize`: process must return 20 + 1 rows and metrology
25 + 1, with the ordinary default metadata and exact original ordered IDs.
The namespace `${freshFixture.prefix}-template-pages` is separate from the
mature 84-request setup owners and every retained earlier fixture. The setup
is needed for the existing PNG/physical checker; no previous browser matrix is
repeated, and no previous Sample/Project/template database state is copied.

`browser-template-pagination-actual-api.mjs` requires exactly these four new
read-only Chromium cases, with no selected-case or helper-hash override:

| Case | Viewport and theme | Target default page size |
| --- | --- | ---: |
| `template-pages-process-390-dark` | 390px touch emulation, dark | 20 |
| `template-pages-process-1280-light` | 1280px, light | 20 |
| `template-pages-metrology-390-light` | 390px touch emulation, light | 25 |
| `template-pages-metrology-1280-dark` | 1280px, dark | 25 |

Each starts with both real first pages, verifies exact ordered primary links,
and uses native focus/Enter for Next. One target-domain GET first receives a
genuine Worker 200, then only its browser delivery is replaced with a controlled
503. Native Retry must recover the true one-row tail while query and the other
domain's page/rows remain unchanged. Previous restores the exact first rows;
Next then opens the tail's original detail source by its native link. Browser
history Back restores the actual query and independent page scope.

The native `Search templates` accessibility name is required. Searching for a
known absent string must reset both page keys and show both empty directories;
restoring the original query must restore the exact 20/25 first rows while
retaining search focus. Touch emulation must not steal initial search focus.
Theme and document-overflow checks cover directory, recovered tail, original
detail and restored query. Every browser case requires zero API mutations,
external origins and page exceptions. Actual observed reads are recorded;
this adds no latency, frame-rate or historical request-budget claim.

Original action/request, body-observation and context/browser shutdown budgets
remain 20,000ms, 5,000ms and 10,000ms. On the first case failure the helper
captures the failure/screenshot, closes its actual context, flushes observations
and throws. Its outer finalizer closes the browser and writes immutable report,
summary and explicit unrun IDs. Context setup failures use the same owned
cleanup path. Failed artifacts and accepted owners remain preserved.

## Fresh artifact, lifecycle and acceptance boundary

The base adopts the byte-preserving canonical shared witness repair and dated
roadmap docs; all other product source is unchanged. The earlier source-only
proof of 1,492 old source entries and 121 exact `2f5d616` artifact bytes remains
historical at `/tmp/phase5f-template-pagination-source-d7d2a88/qualified-2f-artifact-reuse-source-proof.json`
(SHA256 `a205926012b87574c7bdef9df9b0abdf2d229c4522f2dac0af921706e0212a41`).
It is not used to claim a build of the canonical-path source. The new plan
requires a fresh ordinary build on the frozen final QA checkpoint before copy.

After source peer and the coordinator's exclusive runtime GO, stages are:
fresh build; receipt-owned source/artifact copy using the qualified explicit
real dependency root; random hashed process fixture; ordinary local migrations
and fixture SQL; pre-API physical snapshot checks; owned Worker ready; mature
84-request setup; new 102-request seed; four browser cases; stdin `stop` and
actual awaited exit/disposal/port closure; post-shutdown physical checks.
The last two cleanup stages run after any service-started failure as well.

Each stage uses a fresh private namespace and immutable raw log/receipt.
No dependencies, credentials or persisted state are copied. The same mature
physical checker validates DB/WAL/SHM inventory stability during diagnostic-copy
reads, SQLite quick/FK checks, original migrations/sentinels and genuine seeded
PNG bytes. It does not compare a workspace production database.

This plan covers AUTHdisabled local built Worker/D1/R2 and one Chromium engine
with viewport/touch/theme emulation. Actual authenticated administrator/provider,
Node create flow, physical devices/IME and whole-5F completion are separate.
The [role/focus review ledger](PHASE_5F_ROLE_FOCUS_REVIEW_LEDGER.md) keeps older
evidence and this unrun gap distinct. Complete exact-head CI remains required
before integration.
