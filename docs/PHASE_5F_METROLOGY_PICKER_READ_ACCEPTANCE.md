# Phase 5F Metrology picker read ownership

Status: bounded source change and focused local checks passed on 2026-10-10.
Combined-tree qualification is a subsequent gate.

The actual Add metrology grid picker now binds its list to the current query and
read attempt. Changing either immediately removes obsolete actionable rows;
success, failure and completion from aborted reads cannot publish into a later
query. The existing 160 ms nonblank search debounce remains unchanged.

List errors have their own visible read state and **Retry templates** action.
An empty-success message is shown only after a successful current read. Retry
performs that GET again and never repeats template creation or entry insertion.
List success/failure cannot clear the separate mutation error or accepted-template
draft. The preceding pending/session ownership contract remains in place.

| Check | Actual result |
| --- | --- |
| Pre-fix real-grid reproduction | 1 file / 4 failed: stale success, stale error, obsolete selectable rows, list success erasing add error |
| Applied picker plus pending regression | 2 files / 38 passed in 3.56s; 12 picker cases and 26 pending/session cases |

The tests retain the real grid, form and modal with typed API stubs, controlled
promises and fake-clock advancement for the existing debounce. They cover
query/retry supersession, pending reads, repeated read errors, explicit GET-only
retry, successful empty lists and write-error survival. Unexpected fetches are
rejected. Detailed logs are `/tmp/metrology-picker-pre-fix-mounted.log` and
`/tmp/metrology-picker-final-focused.log`; the result summary is durable here.

This is local mounted qualification. It does not claim a browser/live provider
pass, remote migration or cancellation of an already dispatched write.
Standalone Metrology has an independently reviewed follow-up slice.
