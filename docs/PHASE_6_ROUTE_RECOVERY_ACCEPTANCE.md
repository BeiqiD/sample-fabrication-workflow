# Phase 6 explicit route-load recovery

Status: bounded implementation and focused mounted regression passed on
2026-10-10 at 13:00 UTC. Combined-tree build/CI and actual serving-version
deployment handover remain separate gates.

The [recorded deployment handover](BACKEND_RELIABILITY_ACCEPTANCE.md#deployment-handover-observation)
left an old tab requesting a retired lazy chunk. Its generic router error page
required a manual refresh; that did not qualify stale-tab recovery. The current
`App` still had only Suspense, so rejected lazy imports and page render errors
could unmount the shared navigation and offer no product-owned recovery.
This was a pre-existing implementation gap, not a new backend migration defect.

`RouteErrorBoundary` now surrounds the routed content and its Suspense fallback
inside `App`'s main region. A failure presents a focused accessible alert, a safe
message and an explicit **Reload page** button. The navigation and theme controls
remain available outside that boundary. Error messages, chunk URLs and stacks
are not rendered. Reload uses the browser's current URL, preserving pathname,
query and hash; the boundary never initiates an automatic reload, timer, API
request or mutation retry.

Navigating to another pathname clears only the boundary's failed state. The
wrapper is not keyed by router location: changing a healthy route's query/hash
must retain its page instance and local draft. The repair does not promise to
restore a failed page's in-memory draft, cancel a dispatched write or certify a
remote operation. Existing navigation/before-unload and accepted-request guards
retain their own contracts. A browser reload remains a user action.

## Reproduction and local evidence

The regression mounts the actual `App`, with separate controlled rejecting
Projects, Project and Export imports and independent healthy/render-failing route
fixtures. Each rejected-import case settles its own deferred module so that
filtering or changing test order cannot inherit another case's cached lazy
failure. An outer
test observer catches the old uncaught route error; it is not production code
or a replacement for the new real boundary. The API `fetch` witness rejects
unexpected traffic. No test-only production export was added.

| Run | Result |
| --- | --- |
| Pre-fix actual-App mounted regression | **RED:** 1 file, 3 failed / 1 passed / 4 total; 4.51 seconds |
| First post-fix regression | 3 passed / 1 failed / 4 total; the real reload emitted jsdom's navigation diagnostic, but the test's console spy did not observe the environment-owned virtual console |
| Corrected four-case regression | PASS: 1 file / 4 tests; 1.10 seconds |
| Five-case regression before isolation review | PASS: 1 file / 5 tests; 1.46 seconds |
| Final isolated reload case, fresh process | **PASS:** 1 file / 1 test; 4 skipped; 777 milliseconds |
| Final independently settled five-case regression | **PASS:** 1 file / 5 tests; 1.47 seconds |
| Final shuffled five-case regression, seed 683 | **PASS:** 1 file / 5 tests; 1.48 seconds |
| `git diff --check` | PASS |

Final command:

```sh
npx vitest run --config vitest.mounted.config.ts \
  src/phase6-route-load-recovery.mount.test.tsx --maxWorkers=1
```

Independent review found no product-boundary defect. It identified a test-only
shared deferred-import dependency; separate route fixtures corrected it while
retaining the real pending-to-rejection assertion. The fresh filtered run and
shuffled run above verify that correction.

The final tests cover pending import rejection, focused safe failure content,
retained topbar/theme navigation to a healthy lazy page, native button semantics,
explicit reload with full URL retained, existing healthy draft/DOM identity under
query/hash navigation, and ordinary page-render errors. They observe zero API
calls from the boundary. The mounted test uses Vitest's provided jsdom virtual
console to count the real `window.location.reload()` diagnostic: jsdom does not
perform an actual browser reload. The intentional diagnostic is not a failed
product assertion. Real keyboard activation and built-chunk/reload behavior
require the separate browser check.

## Source receipts and remaining gates

The audited predecessor is `86369739160057f45ec8476b7778fdba9c79799d`; other
development commits advanced concurrently. These explicit file receipts qualify
the tested slice without borrowing a full-tree pass from a different head.

| File | SHA-256 at final focused test |
| --- | --- |
| `src/App.tsx` | `d15b6966da3a9b9442e682dc2fa5197f2608ac147be4b23549e0b43894e821a8` |
| `src/components/RouteErrorBoundary.tsx` | `d5611f2246f6b1cfdea453332099e61aca4edef2556d7525aea121baa747bcc7` |
| `src/phase6-route-load-recovery.mount.test.tsx` | `8a69c902ea19011cdc5f91093171dc0b08edb0d28bb118f41f13a2b77295f000` |

Temporary detailed logs: `/tmp/phase6-route-recovery-before.log`,
`/tmp/phase6-route-recovery-after.log`,
`/tmp/phase6-route-recovery-after-final.log`, and
`/tmp/phase6-route-recovery-five-cases.log`,
`/tmp/phase6-route-recovery-isolated-reload.log`,
`/tmp/phase6-route-recovery-isolated-final.log`, and
`/tmp/phase6-route-recovery-isolated-shuffle.log`. Results are retained here because
environment publication can remove temporary artifacts.

Still required: combined-tree review, mounted/build/full required
CI and lazy Map bundle ownership; local real-browser failed-chunk recovery,
keyboard activation and explicit reload; then an authorized actual old-document
to new-serving-version handover. Local fault injection does not establish
deployed stale-tab or physical-device acceptance. No production release,
provider operation, remote migration or automatic replay is claimed.
