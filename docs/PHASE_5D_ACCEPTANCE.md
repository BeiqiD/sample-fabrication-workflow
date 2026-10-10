# Phase 5D attachment and media acceptance

Status: bounded local Phase 5D development complete on 2026-10-08
(Europe/Zurich), following the [completed C4 goal](./C4_LOCAL_DEVELOPMENT_GOAL.md).
Working branch: `codex/fp2-fp3-development`; starting commit:
`129bde6542d2dc58d87db37dbf6aebb1bc40873d`.
The [Phase 5D goal](./PHASE_5D_DEVELOPMENT_GOAL.md) is complete;
Phase 5E is the next implementation slice. Formal
[C4 device/deployed acceptance](./PROJECT_C4_ACCEPTANCE.md#current-remaining-acceptance-boundaries)
remains open.

## Implemented behavior

Shared presentation separates filename, contextual title, description, MIME,
byte size, availability and domain actions. Comfortable Sample/Reading, Compact
Inspector/dialog and Dense Process adapters keep their distinct geometry.
Explicit authorized URLs are preserved; unsafe or missing URLs cannot become
an invented read. Unknown upload statuses cannot become Ready.

Project supports generic-file fallback for unsupported MIME types, honest
unavailable state and decode-error retry. A failed preview retains the existing
original read; image-source changes close stale previews and return focus to a
persistent control. Inspector and Reading use the same model without changing
Project item identity, revision, ordering, gestures or storage routing.

Comment/Run expose existing ready-child removal endpoints separately from pending
upload recovery. Removing a child preserves its owner body, other items and Run
history. Required TIFF originals explain their dependency and remain disabled
until their ready preview is removed; the server remains authoritative. A lost
DELETE acknowledgement or failed owner refresh requires a read before another
attempt. Cancel/reopen preserves that requirement; a confirmed removal is never
resent because a refresh is stale. Read-only Run surfaces expose no new ready Comment child-removal action;
existing legacy image/execution adapters retain their prior behavior.

Canonical Comment and Project Trash retain 30-day wording. Ready Comment/Run
byte removal describes a guaranteed 24-hour recovery window and best-effort
recovery thereafter until cleanup; source-link removal promises no byte recovery.
These dialogs do not advertise an unavailable in-app Restore control. Legacy
note deletion keeps its own domain semantics.

Gallery dialogs contain focus and restore the opener, preserve native authorized
image reads, zoom/pan/navigation and active image identity, and support retry
without losing keyboard focus. Timeline thumbnails stay distinct from full-image
URLs. Client-generated Comment/TIFF previews remain occurrence assets, without
claiming to be originals or verified derivatives. Existing upload controls gain
clear state/progress names and announcements. Enter/Space on a child picker
Remove button no longer bubbles into Browse; queue, acceptance identity, retry,
cancellation and native/legacy routing are unchanged.

## Demonstrated browser repairs

The frozen C4 baseline completed 56 pages. Forty Sample/Run gallery
cases allowed focus to escape or failed to return it after Escape. Four narrow
Sample cases overflowed to 484px because pre-existing FP4 package header actions
reached x=483.91. Missing-locator historical originals displayed misleading Ready
wording. These defects are repaired. The Sample header fix is bounded to wrapping
below 721px, required to make the narrow attachment surface usable; it does not
complete Phase 5E.

The first strict final matrix passed 54/56 cases. Two 360px four-column Run cases
exposed a stretched disabled child-action button. The final scoped CSS keeps the
Dense card and column geometry while reducing that button from 220px to 111.8px,
with its right edge at 356.8px. Original failed evidence is retained. The probe's
initial failure exit status was also corrected without changing assertions or
case definitions; final qualification checks recorded statuses as well as exit
codes.

The first 11-case action run completed its business assertions and restored both
original children, but all cases failed because its theme init script attempted
localStorage access on the initial opaque blank document. That failing report
is retained. The script now sets theme only on the exact local application
origin; the same origin guard is used by the final viewport probe. Application
page-error assertions remain unchanged. All action cases
were rerun rather than relabelling the failed run. Rerun gallery fixture bodies
include a unique run label so preserved earlier owners cannot match the exact
owner selector; previous fixture owners and evidence were not deleted.

The first full Verify attempt passed all 351 script checks and 365 source
files / 3,336 cases, then failed one of 751 mounted cases because Inspector had
duplicate source actions. The caption region also needed its original keyboard/
scroll semantics restored. The legacy duplicate was removed, and only Inspector
receives the named focusable caption region. The existing failing integration
test was preserved; 11 affected source cases and 56 mounted cases passed after
repair. All final browser checks were rerun on the repaired production source;
the original incomplete gate remains archived separately at
`/tmp/phase5d-before-inspector-source-fix/`.

The first four-case Inspector browser run failed before metadata writes: its
exact Caption label locator saw DOM label text `CaptionResult table`, while the
accessibility tree exposed one textbox named `Caption`. All four cleanup checks
passed with the original metadata unchanged; this failed run is retained. A
read-only diagnostic confirmed the mismatch. The harness now selects the exact
accessible textbox name and additionally checks a single match, textarea/input
type and authoritative initial field values. Save/Cancel, caption PageDown,
source-link uniqueness, native hit bounds, write-count and ordinary CAS cleanup
assertions and waits remain unchanged. Four fresh cases passed, each with one
metadata Save and a normal current-revision restoration; the original script,
diagnostic and locator patch remain preserved.

The second full Verify attempt, on the repaired Inspector source, passed its
script checks and recorded a 5,034ms failure in the unchanged native FabuBlox
staging/finalization/retry/GC case. After the observed failure, the exact Vitest
process received SIGINT and source exited 130; this attempt has no complete
source summary or later-leaf result. It remains failed/incomplete at
`/tmp/phase5d-before-native-timeout-fix/`. An unchanged standalone verbose run
then reproduced the definitive `Test timed out in 5000ms` error, with 17 passed
and one failed case. Only that case receives a documented finite 15-second
budget; all fixture, visibility, failure/retry, publication and GC assertions
remain unchanged. The affected file then passed all 18 cases, with the formerly
timed-out case taking 4,538ms. All twelve canonical leaves qualified the new
eligible source fingerprint below; neither failed attempt is treated as a pass.

## Local browser qualification

Chromium 151.0.7922.173 drove the actual loopback Vite/Worker/D1 application.
Both baseline and final applications used separate `/tmp` D1/R2 state, all 22
normal migrations and the existing local `AUTH_MODE=disabled` configuration.
No actual development or production database was used for browser mutations.

Ordinary APIs created CSV, PDF, PNG, malformed PNG and long-filename Project
attachments; all five reads checked the expected MIME and recorded byte size
and disposition. Exact CSV and valid-PNG byte equality was asserted.
Ordinary Comment acceptance/upload/finalize APIs created body/image/link owners.
Additional historical SQL fixtures supply matching multi-Sample geometry and a
client TIFF preview paired with a missing-locator original. This fixture proves
unavailability and dependency behavior; it does not qualify an accepted original
upload or provider capability. No File derivation rows were introduced.

| Check | Local result |
| --- | --- |
| Primary viewport/theme matrix | 56/56 passed: Project Reading, Sample, Timeline, Run 1–4; 1440/1024/390/360 widths, short height, light/dark. |
| Adjacent breakpoint matrix | 84/84 passed: 560/561, 720/721 and 1200/1201 widths, light/dark, the same seven surfaces. |
| Inspector save/cancel and caption | 4/4 passed; 4/4 metadata CAS restorations passed: desktop/mobile and light/dark, real metadata Save, one source link, named keyboard-scrollable caption, later draft Cancel and ordinary CAS restoration. |
| Isolated lifecycle/gallery actions | 11/11 passed; 2/2 original-child restorations passed: Sample child cancel/remove, committed Run DELETE with lost browser acknowledgement, TIFF dependency/server 409, and 0/1/3/8-image galleries at desktop and 390px. |

All 155 final browser cases passed. The two read-only matrices check native
control hit areas, document overflow, metadata, failed-preview retry/focus, truthful availability/trust wording, Tab
containment and Escape restoration, without API mutations or application page
exceptions. The 48 primary and 72 adjacent dialogs belong to Project, Sample
and Run. Timeline navigation/layout was checked; its thumbnail/full-read
separation is covered by mounted tests, without a Timeline browser-lightbox claim.
The actions compare owner body/author/lifecycle and remaining occurrences, require
exactly one DELETE under response loss, preserve the reload requirement across
Cancel/reopen, and reconcile through an actual owner GET. Two removed fixture
children are restored through the normal endpoint, retaining real timestamps and
receipts; additional gallery fixtures remain only in isolated state.

These 155 passing browser cases belong to source fingerprint
`926bc42dae091094c4d0619f69b893d15ef2f44b82269a263b01d174f18318eb`.
Independent comparison of all 1,118 eligible paths confirms the later fingerprint
change affects only the single native test's budget/comment, with no production,
browser assertion or fixture change. Browser evidence retains its actual source
identity rather than being relabelled as the final full gate.

## Automated qualification and data preservation

Full local Verify executes the exact twelve canonical CI leaves from
`scripts/run-verification.mjs --mode ci --list`, with status publication disabled.
Source/mounted suites use two workers. Every leaf starts and finishes at source
fingerprint:
`e458c152920508102afbc651bd79042663e8bdd34d00c6140b4f73ebdfe669c1`.
Documentation changes are outside this eligible code/config fingerprint.

| Canonical leaf / exact command | Result |
| --- | --- |
| `npm run test:verification-scripts` | PASS. 351 checks passed; shared-source ownership verified for 104 files. |
| `npm run test:source -- --maxWorkers=2` | PASS. 365 files / 3,336 cases passed. |
| `npm run test:reference-mounted -- --maxWorkers=2` | PASS. 85 files / 751 cases passed. |
| `npm run test:rich-text-bundle` | PASS |
| `npm run typecheck:export-contract` | PASS |
| `npm run typecheck:file-jobs-node` | PASS |
| `npm run verify:d1-migrations` | PASS |
| `npm run verify:reference-worker` | PASS |
| `npm run verify:reference-search-worker` | PASS |
| `npm run build` | PASS |
| `npm run test:project-map-bundle` | PASS |
| `npm run verify:project-worker-artifact` | PASS |

The complete source and mounted suites contain the permanent Project Map
performance kernel/large-fixture checks; build and Map bundle checks complete
that gate without rerunning duplicate leaves. Reference/search and production
Project Worker checks use isolated local state, including expected missing-JWT
Access rejection rather than successful authenticated Access qualification.
Original-upload routing is qualified by existing native Worker/source tests,
separately from the historical browser fixture above. Earlier focused helper,
adapter, mounted and build checks passed; their pre-final-CSS fingerprint remains
recorded rather than being relabelled as the final full gate.

Independent final code review covered ownership/lifecycle, exact child identity,
uncertain-outcome reconciliation, focus, URL/preview trust and density; no blocking
issue remained. The actual development database matches the consistent pre-5D
snapshot exactly: complete schema, all 119 application tables / 33 rows, typed
cells and physical rowids, all 22 migration receipts and unchanged migration SQL.
Quick check is `ok`, foreign-key violations are zero; File mode remains legacy
and execution guards remain disabled.

All reports, screenshots, harnesses, original failures, verification logs, source
manifest, review and data proof are preserved at
`/tmp/phase5d-final-qualification-checkpoint/`. Original source/database snapshots
remain at `/tmp/phase5d-development-baseline/`; baseline/current browser manifests
identify their separate persistent state. Local browser servers were stopped
after qualification. No push, deployment, remote migration, provider activation
or production-data movement was performed.

## Remaining acceptance boundaries

Controlled headless CSS viewports and mouse/keyboard interactions do not qualify
physical touch, Windows/macOS IME, native mobile engines or soft keyboards.
Local disabled authentication does not qualify successful Access/admin identities,
real provider connectivity or deployed runtime. The lost-ack harness is controlled
local transport evidence, and wording checks do not simulate elapsed 24-hour or
30-day recovery windows. Large-Project performance tests do not establish a new
real-device frame-rate claim. Existing formal C4 and release/recovery boundaries
remain explicit.

Next: [Phase 5E](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md#phase-5e--source-record-and-directory-coherence)
source-record/directory coherence, then Phase 5F integration review and Phase 6B
release preparation. This checkpoint does not start those implementation slices.
