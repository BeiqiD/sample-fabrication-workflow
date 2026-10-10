# Initial read recovery, confirmed-owner refresh and reduced motion

Project pages with a failed initial GET now expose an accessible Retry action.
Enter retries the same fenced read without changing the route or creating a
write. Existing snapshots and dirty edits retain their existing recovery flow.
Confirmed Processing groups capture the exact unique Sample owners submitted
by the original action. A three-owner group refreshes those three owners;
ordinary Retry and operations with unknown owners retain the full refresh.

Navigation scrolls honor the current `prefers-reduced-motion` setting. Pending
recipe icons and reference loading indicators stop their decorative animations
under that setting while retaining their pending locks and loading semantics.
Grid geometry, accepted payloads and acknowledgement ownership are preserved.

## Exercised product and bounded checks

The exercised product is `6c4dc88800f783cd756ce6370fb4d8f4764f952c`, tree
`31a4f00026345f8e54818566e95d54d0441a0e5c`. A fresh build exited 0. A clean
private checkout retained 1,305 matching tracked files and 124 matching build
artifacts. Its isolated copy excluded existing persistence. Twenty-two ordinary
migrations and 84 real application API preparation requests completed before
the browser checks. Installed dependency files were copied from the existing
installation; this was not a dependency update or another fresh build.

| Distinct check | Result and scope |
| --- | --- |
| Mixed Chromium matrix | 20/20 passed: actual process/plan writes, 720/721/1200 light/dark surfaces, source links, PNG, administrator denial and route-chunk recovery |
| Initial Project read recovery | Selected case 1/1 passed: 503, native Enter Retry, actual 200, retained full URL/original Project, zero UI writes; not a rerun of the historical twelve-case supplement |
| Processing cost | Six phases passed; Sample GETs **8,0,1,3,7,8**, decoded bytes **26,104;0;3,329;9,859;22,911;26,174** |
| Pending/search motion | 6/6 passed at 720 dark, ordinary/reduced motion: native jump scroll, actual search loading and server-accepted held group acknowledgement |
| Suggestion loading motion | 2/2 passed at 720 dark, ordinary/reduced motion; four real read-only children POST responses delivered once, zero CRUD, original Project unchanged |
| Controlled stop and physical persistence | Disposal awaited, exit 0, port closed, owned process absent; four SQLite quick/FK checks passed and seeded PNG bytes matched |

The group response drops from eight reads / 26,174 bytes to three / 9,859,
removing five unrelated reads / 16,315 bytes. Final actual readback retained
original plan/fabrication identities, correction note, three Done and five
Pending Steps, and all five unaffected owners. Instrumentation/control reads
are distinguished from the product counts. These are finite request-volume
measurements, not a latency budget.

The private mounted suite passed 102 files / 980 tests for Retry/group. Fourteen
new characterizations and 35 applied focused cases passed after the repairs.
Reduced-motion changes passed 117 existing mounted cases, application types and
the fresh build. An earlier actual pre-motion baseline passed three ordinary
motion cases and failed three reduced-motion cases as expected. These checks
retain their source and command scopes; they are not the final branch's complete
CI qualification.

## Browser observation repair and retained failures

The first 6c4 matrix stalled on an incidental GET body observation after its
route had unmounted. Fourteen cases passed before diagnostic context closure;
two closure failures remain unqualified. The application route and independent
health/readiness requests completed. This observation established a harness
stall, not a product defect.

The reviewed helper bounds response-body observation and teardown. Required
mutation and preview JSON captures fail closed. The successful matrix captured
all 30 required bodies, with no pending or missing required observation. It
retained 13 unavailable incidental GET bodies explicitly; it does not claim
every observed response body completed. The supplemental helper SHA256 is
`71a2d573239c973e3ec487516b75a879cbaf5baaa73e4e3b35c00243466af16d`.
The same helper was adopted after product qualification; this did not create a
new product build. The initial suggestion run retained one pass and one wrong
keyframe-name harness expectation failure. A separately frozen corrected
expectation then passed both read-only cases.

[Durable condensed receipts](PHASE_5F_RETRY_GROUP_MOTION_RECEIPTS.json) preserve
source/artifact/helper hashes, distinct runs, failures and physical limits.
`originalStateBytesUnchanged` in the physical checker means the isolated
persisted inputs remained byte-identical while private diagnostic copies were
read. It does **not** compare the canonical workspace database before/after.
Descriptor inspection covered accessible processes only.

## Integration and remaining acceptance

PR #252 merged on 2026-10-10 at 15:03:29 UTC as
`fc3abc3eac6085cfde8af97b44a9b6d91ac62a15`, preserving its qualified final
`989f1b6` tree `15d89bf222c6a16adfc15b857a8f75943b485912`. Its four final-head
Verify/Map runs and all fifteen public contexts passed before the ordinary
merge. Post-merge Map passed; post-merge Verify attempt 1 failed five existing
source cases at the unchanged 5,000 ms deadline. That failure remains recorded
separately from the pre-merge qualification. One failed-job rerun was requested;
its result is recorded separately when observed. No production main release or
actual serving/schema/provider acceptance is implied.

This follow-up branch starts from fc3 and retains the exercised frontend source
with an additional reviewed QA helper and documentation. Its final complete
local/remote checks remain pending. Separately, draft portable-runtime PR #253
at 7cdee51 failed its local full source gate on one default-deadline case, its
push source gate on another, and its PR mounted gate on a focus assertion.
Those failures are being investigated and are not inherited qualifications.

Whole 5F, directory-pagination actual browser coverage, physical input/IME,
other browser engines, authenticated serving/schema/provider rehearsal and
enabled-scope 6A6/6B remain open. RT1–RT6 and subsequent small-group membership
and resource authorization are still unfinished. Optional exploratory roadmap
items retain their conditional status.
