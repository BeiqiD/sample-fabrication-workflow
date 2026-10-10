# Phase 5F Processing owner refresh checkpoint

Date: 2026-10-10. Status: the bounded owner refresh change passes prototype and
applied-source focused and full mounted/build qualification. The committed
implementation also passed the optimized actual-API browser measurement; the
final candidate head's full remote gate remains pending. This checkpoint does not
close all Phase 5F or establish a browser latency budget.

## Measured baseline

The accepted roadmap requests measured removal of unrelated Processing reads.
Before this change, every grid `onSaved()` called the page's full
`Promise.all` reload of the primary Sample and all additional visible Samples.
The following finite probe used eight dedicated synthetic Samples, each with a
real active process Run and two populated plan Steps. Samples and Runs were
created through the actual local API; two fixture template sentinels and the
served Processing asset hash were checked before UI work. The probe used the
supported Step correction and grouped confirmation controls, actual HTTP
responses, Chromium **151.0.7922.173**, a **1440 × 1000** light viewport, and
isolated loopback `AUTH_MODE=disabled`. It changed neither a retained database
nor a remote provider.

Baseline source: `af8f374cfbbade3282f2e686cc9f35d3c40adf4a`, tree
`087749d12a3e3ad19473f1f4e63d29e1ecf1c269`. Development merge
`aa497d9a1a304751ea7533548573a256799ef734` has the same tree. The successful
probe ran from **2026-10-10T13:18:13.247Z** to **13:18:19.313Z**, after the
fixture owner's completed 20-case matrix and an exclusive browser handoff.

| Supported UI phase | Processing GETs | Decoded response bytes | Accepted writes | Whole phase time |
| --- | ---: | ---: | --- | ---: |
| Initial eight-column load | 8 | 26,104 | 0 | 930.22 ms |
| Select three columns | 0 | 0 | 0 | 371.96 ms |
| Correct one Step | 8 | 26,170 | 1 PATCH, HTTP 200 | 1,077.43 ms |
| Confirm three selected Steps | 8 | 26,174 | 1 POST, HTTP 200 | 507.86 ms |
| Remove eighth visible column | 7 | 22,911 | 0 | 355.09 ms |
| Add eighth visible column again | 8 | 26,174 | 0 | 617.89 ms |

After the single-owner correction, the affected response contained **3,329
bytes**. All seven unrelated responses had unchanged SHA256 hashes compared
with the initial read and contained **22,841 bytes** in total. After grouped
confirmation, the three affected responses contained **9,859 bytes**; the five
unaffected response hashes were unchanged and contained **16,315 bytes**. This
demonstrates redundant owner reads without assuming that network latency is the
dominant cost.

All 46 browser API responses were HTTP 200, with no forbidden request or page
error. Of these, 39 were Processing reads, two were accepted writes, and five
were storage/picker control reads. Seed, preflight and final readback requests
are recorded separately. Final real API readback confirmed three completed
first Steps, five pending first Steps, only the first owner's correction note,
unchanged plan revision IDs and two Steps in every Run.

Whole phase times include UI typing, focus, DOM settling and instrumentation;
they are not server latency or ACK budgets. Response bytes are decoded JSON
body sizes, not compressed wire sizes. Passive DOM mutation observations are
not React render/commit counts. No optimized browser timing is claimed here.

Two earlier harness attempts used incorrect exact native-label locators for
the correction form. Both failed before dispatching any UI PATCH/POST. Their
separate receipts and dedicated owners are retained; the corrected probe used
new owners and supported role/prefix locators without changing product code.

## Bounded delivered behavior

The real StepDrawer and grid MetrologyPicker now identify their original
single Sample to `onSaved(affectedSampleIds?)`. The page passes this optional
scope as a separate argument to `load(propagateError, affectedSampleIds?)`.
The existing attachment strict-error boolean retains its meaning.

Only a complete current-source cache and a nonempty known visible-owner scope
permit a partial read. Successful partial reads replace affected Sample
objects while preserving all other object references and the visible order.
Response IDs must match their requested owners before an atomic install.
Initial reads, empty/unknown scopes, grouped operations, comments,
attachments, run transitions, opaque/default callers and Retry remain full.
The grouped optimization is deferred despite its measured redundant reads.
Accepted write payloads, template creation, API routes and schema are unchanged.

A source-owned pending invalidation set persists until a current-generation
read succeeds. Therefore A followed by B refreshes A and B together; full and
partial overlaps retain the full scope. Failed or superseded requests cannot
clear outstanding invalidations: a subsequent C refresh still covers failed
A/B. Generation, source-session identity and lifetime checks fence stale
results, stale callbacks across A → B → A, and unmount. Ordinary current read
failure preserves data and exposes full Retry; strict attachment refresh
continues to reject current or superseded failures.

## Focused qualification

The new host tests mount the actual Processing page and router with typed API
stubs. A controlled grid boundary permits precise settlement of concurrent
read responses without fabrication writes. The owner tests mount the real
MultiSampleRunGrid, exercise supported secondary-owner Step/Metrology actions,
and assert the complete accepted write payloads. Unexpected fetch rejects.
No production test deadline or global timeout was widened.

| Qualification | Result |
| --- | --- |
| Exact same 21 new mounted cases against baseline af8 | Expected FAIL: 14 failures, 7 passes; 2.47 s |
| Private prototype, new mounted cases, one worker | PASS: 2 files, 21 tests; 2.62 s |
| Existing Processing preview, grid Metrology pending and standalone Metrology session cases, prototype, one worker | PASS: 3 files, 70 tests; 10.97 s |
| Prototype `npx tsc -p tsconfig.app.json` | PASS |
| Applied live source, both new mounted files | PASS: 2 files, 21 tests; 1.62 s |
| Applied live source, complete mounted suite | PASS: 100 files, 966 tests; 66.89 s |
| Applied live source, `npm run build` | PASS |
| Independent read-only race and original-owner reviews | No concrete correctness regression found |

The new tests cover exact single-owner GET counts, unaffected object identity
and order, clearing covered invalidations, A/B success and failure overlap,
both full/partial overlap orders, failed union followed by C, full Retry,
strict current/superseded attachment errors, mismatched response ownership,
source reentry and unmount. Real-grid cases prove original secondary-owner
write payloads and Metrology callback capture across fresh Run objects and a
replacement callback; the pending drawer waits for the original refresh.
Grouped writes retain the no-argument full callback.

The implementation was committed as `a6dfd237a3cff90376bc5375a2bf318e3aa4f6a6`
on development parent `aa497d9a1a304751ea7533548573a256799ef734`. The root's additional Metrology
search accessibility label is included in the current Grid file. Applied
source SHA256 values are:

- `src/pages/ProcessingWorkspacePage.tsx`: `c8183e92e3569484452cba2bbfa1c671f7124c5ea91c537952cdc6a61061992c`
- `src/components/MultiSampleRunGrid.tsx`: `70641d0dd65e160ddf6e54895ee8aa80b27cb6b9a9b0c82f8c3a411ce652b98c`
- `src/phase5f-processing-refresh.mount.test.tsx`: `b2a9d1cad9af7ad3620e355b2b670a5a9ebea17e9d8a918e50abac2c455333e7`
- `src/phase5f-processing-refresh-owner.mount.test.tsx`: `efdf2f256151ec5d4e1e3bcaa36f56e8e175cb634fc1b7d1a9380a9aa570a4ec`

## Receipts and remaining qualification

Baseline served asset: `ProcessingWorkspacePage-BVwkeGJL.js`, SHA256
`8249eec6b402a7e605a563c7720320eb27940564d683c896fd7a9d677e2b611a`.
Scratch receipts may disappear after environment replacement; measured values
and their limits are recorded above.

- `/tmp/phase5f-processing-cost-af8f374-attempt3/processing-browser-cost.json`: `ac70bfa9c1a92324512c8a902aaead291f82548beead5da64651edcd0a92d4d9`
- `/tmp/phase5f-processing-cost-af8f374-attempt3/dedicated-owners.json`: `f049fe783a13b5281462cbcdf2e3d4b502b05886aa5d17ff30c161c7f16415f6`
- `/tmp/phase5f-processing-cost-af8f374-attempt3/processing-eight-columns-final.png`: `9bceb87d3010bd0530cb18dcd2325cde4c12d3538ff42515d8cd78b1b7cbd72a`
- `/tmp/phase5f-refresh-exact-baseline-red.log`: `5411767a2a32be85fbd2474c40607ee0fc9af0322601b5ce7a7edd8b6fab41d2`
- `/tmp/phase5f-refresh-prototype-green.log`: `63db2cb26b55b61638348e659b15702f3f4e41dd1adf651347be1dda555e94e9`
- `/tmp/phase5f-refresh-existing-focused.log`: `acacf744c9b6fabe6a276e3c00f05a330f9157789a7da125d1d4effe00fce431`
- `/tmp/phase5f-refresh-live-focused.log`: `24a4f3c78e241cb38b928864cf1f759d43d95d3229391234759ddf3ae86760d7`
- `/tmp/phase5f-processing-refresh-prototype-receipt.json`: exact prototype source, patch and artifact bindings.

The fresh committed `ee1713393f5dea1f6bbd7a856c7586a8e517591c` build
passed all six actual-UI cost phases with Processing GET counts **8,0,1,8,7,8**.
Single-owner correction used one GET / **3,329 decoded bytes**, removing seven
unrelated reads / **22,841 bytes**; grouped confirmation retained eight GETs.
Both UI writes returned 200, all 39 browser API responses returned 200, and
final actual API readback preserved the original plans and three Done / five
Pending Steps. The adopted pipeline also passed its complete 20-case matrix,
awaited disposal with exit 0, and final four-SQLite/FK/PNG checks. These results
remain pinned to the exercised commit, with raw hashes and scope in
[the current browser checkpoint](PHASE_5F_CURRENT_BROWSER_ACCEPTANCE.md).
The final #252 candidate passed its own four Verify/Map runs and all fifteen
contexts, then merged as `fc3abc3`. Its post-merge source timeout failures remain
separate. The later three-owner group reduction is qualified in
[the follow-up acceptance](PHASE_5F_RETRY_GROUP_MOTION_ACCEPTANCE.md), whose final
branch complete gates remain pending.
The existing Map/Reading and 250/500 Save-cost acceptance remain separate
finite measurements; this change does not add a batch placement protocol.

### Adopted QA pre-API failure retained

Candidate `a6dfd237a3cff90376bc5375a2bf318e3aa4f6a6` was committed and pushed
as [PR #252](https://github.com/BeiqiD/sample-fabrication-workflow/pull/252).
Its fresh build passed. The first adopted-helper attempt copied 1,298 tracked
files and 123 artifacts, applied 22 ordinary migrations and the template SQL,
then failed the physical-checker's all-state-byte-stability assertion before
starting any server or issuing API/browser writes. Both physical SQLite
quick/FK checks passed. The first pre-read inventory was not persisted, so the
exact changed file is unknown; a later independent read-only observation had
no observed open state descriptors and unchanged before/after inventories.
SQLite reader coordination is a plausible cause, not a confirmed file identity.

The bounded checker correction diagnoses byte-identical private copies of
quiescent DB/WAL/SHM groups, verifies original inventory stability, records
accessible descriptor inspection and its limitations, and binds the separate
awaited-stop receipt and seeder's actual `serverSessionId` field. It does not
change application code, migration SQL, authentication or accepted data. The
failed attempt and observation remain at:

- `/tmp/phase5f-a6dfd23-fixture/physical-sqlite-before-api.json`
- `/tmp/phase5f-a6dfd23-fixture/physical-diagnostic-readonly-observation.json`

A new committed build and fresh fixture are required for the corrected helper's
actual startup, browser, named-search, cost and controlled-stop qualification.

The corrected snapshot functions passed a finite retained-WAL manual probe:
the committed WAL row remained visible, all three original DB/WAL/SHM files
kept exact byte hashes, quick-check was `ok` and FK checks were empty. This is
helper-function evidence, not application/browser qualification. Its receipt is
`/tmp/phase5f-checker-snapshot-manual-pass-9nel7n7s/snapshot-receipt.json`;
the initial strict `/proc` inspection rejection is retained separately in
`/tmp/phase5f-checker-snapshot-manual-s82r5a3g/manual-attempt1-failed.json`.

The `ff2a113f5831361c8a4c3a6287a413bae41df96b` attempt passed the corrected
pre-API physical check, then failed Worker startup before API/browser writes:
Miniflare defaulted module resolution to the caller directory outside the copy.
Startup cleanup also rejected, so the original launcher did not produce its
failed ready receipt. The separate observation preserves that missing-receipt
fact, dead process and refused port in
`/tmp/phase5f-ff2a113-fixture/isolated-server-startup-observation-failed.json`.
The bounded launcher now fixes both runtime and module roots to the copy and
preserves startup failure even when disposal fails. A private module/relative-
import probe served HTTP 200 from an unrelated caller directory and awaited
disposal with exit 0; it is not application/API/browser proof. The root-only
failed probe and successful explicit-module-root probe are retained respectively
under `/tmp/phase5f-module-root-probe-2topcN/` and
`/tmp/phase5f-module-root-probe-pass-m0Cqqq/`.

The first `ee17133` named Metrology attempt preserved a zero-case, zero-API
preflight failure: its provenance check required `sourceTree`, which the
launcher omitted from lifecycle identity. The bounded helper correction adds
that field without weakening the check. Named-search/create/add/refresh
qualification requires a fresh committed fixture after this correction; the
historical placeholder-based cases do not qualify the native accessible name.

Fresh committed `c06cb71` qualification passed the adopted 20-case matrix and
both named Metrology cases, then awaited disposal with exit 0 and passed final
four-SQLite/FK/PNG/original-byte checks. Exact receipts and preserved failures
are recorded in [the current checkpoint](PHASE_5F_CURRENT_BROWSER_ACCEPTANCE.md).
No application source changed between the exercised `ee17133` cost measurement
and `c06cb71`; the served Worker and Processing chunk hashes are identical.
