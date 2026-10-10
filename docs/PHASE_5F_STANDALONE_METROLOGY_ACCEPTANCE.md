# Phase 5F: standalone Metrology session and query ownership

Status at `2026-10-10 12:48:22 UTC`: implemented and focused mounted verification passed; combined build, full mounted qualification and remote CI are still pending for the final reentry correction. An earlier combined full mounted/build pass predates that correction. This receipt does not mark all of Phase 5F complete.

## Goal and applied boundary

Keep each standalone Metrology start tied to the original dialog opening and sample. Navigation or replacement of that opening must prevent a late start result from navigating, refreshing or changing another session. Keep the picker directory tied to the current query and retry, with no obsolete selectable rows and a read-only retry after a current directory error.

Changed source is limited to `src/components/StandaloneMetrologyDialog.tsx` and the standalone picker opening/callback in `src/pages/ProcessingWorkspacePage.tsx`. The new mounted suite is `src/phase5f-standalone-metrology-session.mount.test.tsx`. It retains the real dialog, route, page and shared modal hook. The host cases mock the unrelated grid and reference-focus boundary. Typed API stubs and controlled promise settlements exercise receipts; a rejecting global fetch stub ensures no real server, provider or database is contacted.

The dialog now owns a synchronous operation lock and a mount/sample session. It captures the original sample id and `onStarted` callback, fences callback/error/finally after settlement, and remains pending through the callback. Escape, backdrop, Close, Cancel, choices and search cannot start competing work while pending. Manage templates retains a real `/templates` link with disabled ARIA/tab behavior and prevented ordinary clicks while pending; ordinary idle navigation remains available. External navigation can still abandon an accepted request, so session fences remain necessary.

The host opening is an object stamped with its existing `readKey` (`sampleId` and visible-source URL representation), rather than a persistent boolean. A different read source hides and clears the old opening; returning to the first source does not resurrect it. Repeated Start metrology actions while the same-source opening exists preserve that opening's identity. The host callback checks both the current opening and current read source. It preserves its ordinary close-before-load flow.

The directory keeps one owned read record for rows, loading and error. A query or retry starts with no rows. Abort/current-owner guards apply to success, failure and finally. Mutation errors remain separate from directory errors; a later successful query cannot erase a failed start. A current read failure shows an alert and **Retry templates**, which dispatches only the same current-query directory GET. No automatic POST retry was introduced.

## Retained red evidence

Before changing either source path, their bytes matched `4b2c660267b794d09798f961efe8d11ba6e1df86`:

| Source | SHA-256 before this change |
| --- | --- |
| StandaloneMetrologyDialog.tsx | `16a7cf28e87204474663cdcbb28d1be2877d35e3733b0b456320396d22a67eb8` |
| ProcessingWorkspacePage.tsx | `6039c7bef62d1674e723913f5431b6506ffc633127d64b22a4cbe374772048a3` |

At `12:40:57 UTC`, `npm run test:reference-mounted -- src/phase5f-standalone-metrology-session.mount.test.tsx` exited 1: **1 file failed, 4 tests failed**. Each failure demonstrated its expected defect:

- Unmount while `startMetrologyRun` was held, then accept its response: the abandoned `onStarted` spy was called, failing `expect(view.onStarted).not.toHaveBeenCalled()`.
- Open the real Processing picker for sample A, navigate to B, then finish B's read: a `Choose a metrology template` dialog remained, failing the expected null query.
- Hold the old empty-query directory, resolve the newer Raman query, then resolve the old SEM directory: SEM replaced the current result, failing the expected absence of its selectable button.
- Change an already loaded SEM directory to a held Raman query: the old SEM button remained selectable immediately after the query change.

The first implementation passed 20 focused cases at `12:43:56 UTC`, but independent review identified a query cycle: successful empty-query rows → held Raman query → return to the empty query. Its deterministic owner matched the cached earlier rows. A separate actual mounted reproduction at `12:45:36 UTC` exited 1: **1 test failed, 21 skipped**. The failure received the old selectable SEM button where null was required. The applied implementation fixes this by clearing rows in a single owned read record and exposing only settled successful current rows.

After the expanded 22-case focused pass, parent qualification reported **97 files / 939 mounted tests passed** and a successful build for that earlier source. Independent review then identified another concrete case: repeating the background Start metrology action while its first start is pending replaced the host opening object without remounting the dialog. The captured current-session callback subsequently rejected its own valid ACK. A mounted reproduction at `12:48:12 UTC` exited 1: **1 test failed, 22 skipped**; the picker remained open after the accepted response when closure was required. The final opening updater preserves the existing object for the same source. This source correction requires final combined qualification; the earlier full pass is not attributed to the corrected source.

Raw scratch logs are optional execution artifacts and may disappear when the environment is rebuilt. The observed failures above and their digests are retained here:

| Scratch log | SHA-256 |
| --- | --- |
| `/tmp/phase5f-standalone-metrology-prefixtest.log` | `ff61506d2552d6a78805b5c80a8d053fa02746a1b2b6feb852d9ccfae7fe82e3` |
| `/tmp/phase5f-standalone-metrology-querycycle-red.log` | `22ea5f46e77a170090baa8e2d7ad1cb29f718d5a2cc79f7786f5b27cbef718fb` |
| `/tmp/phase5f-standalone-metrology-reentry-red.log` | `3e34ec33c9eb13eb1a077e0fb3734c463612cdea1da63f243f09978412b420ba` |

## Applied focused verification

At `12:45:54 UTC`, the full dedicated command exited 0: **1 file / 22 tests passed**, 3.11 seconds. The log is `/tmp/phase5f-standalone-metrology-focused-final.log`, SHA-256 `66547ff3f768c994897399b47d26eaf96e11830f5ff44d0ecb86561ecc7428b1`.

After the reentry correction, at `12:48:22 UTC`, the same dedicated command exited 0: **1 file / 23 tests passed**, 3.15 seconds. Its log is `/tmp/phase5f-standalone-metrology-reentry-fixed.log`, SHA-256 `59c13593478d4ca134b42226bc838e394cbb57508d2532253d4d71546c3c5e08`. The final focused receipt below applies to this corrected source.

Coverage includes the four original defects, the query cycle, obsolete directory rejection, exact same-query read retry, separate mutation error retention, exact original POST payload, blocked dismissals/link/search/duplicate choices during both POST and callback, old success/failure after a same-target remount, current callback rejection without replay, same-mounted sample target replacement, real-host old-source acceptance while a newer opening is pending, source return and visible-source changes, ordinary host close-before-load after a GET failure, same-source repeated-opening identity, four idle dismissal paths, initial search focus, modal Tab trapping and idle Manage templates navigation.

Qualified focused source digests:

| File | SHA-256 |
| --- | --- |
| StandaloneMetrologyDialog.tsx | `d35eee26729d6c76d3b3c95f1d86b9aa364871cf2acac9f728794cf259c716e3` |
| ProcessingWorkspacePage.tsx | `46d097aa524fc07a82204385bdbcb6cfcf07b0726f4224639ed6c63d7cf96f6c` |
| phase5f-standalone-metrology-session.mount.test.tsx | `5542a564a2b6c911c040465baf24a65e30c19d6befde9f084664ef31ca1d623e` |

## Preserved behavior and limits

`startMetrologyRun(originalSampleId, { templateVersionId })` still dispatches once per explicit successful submission; the current callback receives the returned run id. These API receipts do not expose retained request identities or reconciliation. A dispatched request can be accepted after navigation; this work neither cancels nor rolls it back, removes the accepted run, guarantees duplicate prevention after an unknown ACK, nor retries a POST automatically.

Processing's ordinary `onStarted` callback still closes the picker, selects the accepted run and calls `load()` with its normal non-propagating read-error behavior. A GET failure appears as the host read error with the picker closed. An explicitly rejecting standalone callback in one mounted test verifies cleanup; it is not a claim that the ordinary Processing GET failure rejects that callback.

No backend, schema, provider, storage configuration or shared modal change was made by this slice. This local stubbed evidence does not qualify an authenticated remote Worker, live provider operations, a physical input device or the broader Phase 5F browser/theme/responsive matrix. Those remain separate acceptance entries.
