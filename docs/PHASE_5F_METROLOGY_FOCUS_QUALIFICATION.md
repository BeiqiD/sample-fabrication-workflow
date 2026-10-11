# Metrology idle view-return focus qualification

Date: 2026-10-10 UTC. Qualified source: `d191eac9aab2f5b89037a3630eb68e417e8046e2`.
**Application strict, all41 affected mounted cases and a fresh build passed.**
The [exact evidence index](qualification/phase5f-metrology-focus/qualification.json)
retains the two actual initial failures, immutable logs/case JSON, source reviews,
all three new command receipts and the fresh118-file artifact manifest.
The actual new finite receipt SHA256 is
`a0b2306f579096fbd8f328451084a6d34d931852bdb6c4d96b8da68190bafea8`.

The original real-grid Cancel characterization failed: idle Cancel remounted
Search but left focus on body (source732,1FAIL/26filteredUNRUN). After the narrow
Cancel repair, source7ba independently passed strict39/build. A later meaningful
Escape characterization on7ba also failed: the original Metrology menu action
had actually unmounted, Escape dismissed the drawer and focus stayed on body
while the same Step Add button remained connected (source4f,1FAIL/27filteredUNRUN).
Both test commands exited1; diagnostic wrappers exited0 after recording/reaping
their failed children. Those observations remain failures.

The combined repair keeps explicit idle Cancel's current-drawer Search return.
The original Step Add button supplies a persistent ref through the same Metrology
opening callback/state to the existing modal returnFocusRef. The unchanged
common hook applies its normal connected/visible/enabled owner guards. No global
modal hook, query, read/session, accepted-operation, API, domain/grid/revision,
provider or authentication path changes. An unmounted Step cannot supply a target.

On the exact combined source, the original mounted configuration and5s defaults
ran all26 original pending cases,12 picker-read cases and three meaningful
Cancel/Escape/Close focus cases: **41passed,0failed,0pending,0todo**. Original
one-worker/serial/bail1 assertions and budgets were retained. Ordinary
`npm run build` then produced a fresh118-file artifact on that same source;
the old7ba artifact was not reused. Existing39 and new41 totals are separate.

All three direct children exited0 and were actually reaped. Strict/mounted groups
were empty; the build retained one kernel-Z child with PPID1 and inaccessible FD
metadata. Its observed kernel state establishes exited resources, not an observed
zero-FD count or whole-host quiescence. No cleanup signals were needed. Tracked
source pins stayed unchanged.

This proves DOM focus in the genuine mounted grid with typed API stubs. Two
separate native-Chromium controls at390dark/1280light remain UNRUN pending a fresh
isolated current Worker/API fixture and owned physical closure. Enabled-admin
JOSE/JWKS, own-head CI and an ordinary reviewed development merge remain separate.
No historical browser matrix was rerun; whole5F, physical devices, IME, live
providers and production deployment are not declared complete.
