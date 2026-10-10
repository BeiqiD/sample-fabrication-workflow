# Phase5F initial read recovery and confirmed group refresh

A failed initial Project GET previously left only a Projects link. The initial no-snapshot error now uses the shared alert and a native **Retry loading Project** button, calling the existing generation/source/lifetime-guarded loader. Retrying reads only, retains the full URL and disappears while pending. An error after an existing snapshot still has no new initial Retry action, preserving dirty/conflict recovery.

Confirmed Processing groups now pass the unique original Sample IDs captured from the exact submitted Step targets into the existing owner-scoped refresh. The write payload and original callback remain unchanged. Done or unchecked owners are excluded; stale callbacks, failed/mismatched reads and overlapping invalidation keep the already-qualified page guards. Other opaque operations still use full refresh.

The baseline was characterized before either fix: initial Retry had5 failing/1 passing mounted cases and one expected actual-browser failure with zero writes; confirmed three-owner groups still read all8 owners. Each candidate received an independent ownership/recovery review. The combined private source passed7 focused files/45 cases, the complete102-file/980-case mounted suite and app types. Applied source passed4 focused files/35 cases and app types. All1,158 existing non-documentation files plus2 new tests match the qualified private source byte for byte. [Condensed receipt](PHASE_5F_READ_RETRY_GROUP_RECEIPTS.json) retains hashes and provenance.

Actual new-artifact browser acceptance, controlled stop/physical checks and final exact-head CI remain required. The planned finite probes must show initial GET503→native keyboard Retry→actual200 with no mutation or URL change, and Processing phase GET counts8,0,1,3,7,8. Five untouched owner hashes are checked by separately labelled final control reads. These are bounded development repairs and do not complete all5F or any provider/physical-device/full-runtime milestone.

Committed `9956805` then passed the complete20-case actual built-Worker matrix.
Initial Project503→native keyboard Retry→actual200 passed with no writes and
full URL retained. Six Processing phases passed GET counts8,0,1,3,7,8: grouped
response bytes fell26,174→9,859 and five untouched owner hashes matched in
separately labelled final API controls. Native RunStep source navigation, Back,
Forward and reload retained exact source focus, with original Project/Sample
bytes unchanged and no CRUD. Awaited stop exited0 and final4SQLite/FK/PNG/
original-byte checks passed. This source predates the reduced-motion change.

The additional reduced-motion repair disables busy-icon and reference-search
shimmer animations under the preference, and reads the current preference
when scrolling columns or paginating Samples, Processing and Templates.
Jump-to-current timing/geometry and operation state remain unchanged.
The applied seven-file candidate matches its private117-existing-case mounted
qualification and app types. Actual baseline/new artifact checks are pending.
