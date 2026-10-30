# Phase 5F initial bounded acceptance

Checkpoint: 2026-10-09 (Europe/Berlin), branch `codex/fp2-fp3-development`.
Pushed frozen code: `3c1baf5fdb21994c0510754eb20919db8189a91a`.
Tree: `eda8a59c55817a0c1adab5ba759f956a82e826f3`.
Goal: [Phase 5F initial local integration goal](PHASE_5F_DEVELOPMENT_GOAL.md).
Durable evidence: [implementation, CI and source-delta receipts](PHASE_5F_INITIAL_RECEIPTS.json).

The bounded source changes, local mounted/build and exact-head complete/default
Verify passed. Run `37984549600` completed SUCCESS at 20:30:28 UTC; all 15
published contexts succeeded, qualifying the canonical 12-leaf gate for `3c1baf5`.
This checkpoint does not close whole-5F, provider, device or release acceptance.
No production deployment, remote migration, provider activation or actual
development-data write was performed.

## Resulting behavior

First-read errors in research packages and system recovery give safe status/retry
guidance, preserve validated helpful preflight reasons and avoid uncertain-write
instructions for a read. Package receipts/errors must still own the current saved
intent; an old operation cannot clear a newer request or change its retry payload.
Processing previews belong to their source/session/selection; obsolete results,
errors and completion cannot alter a newer dialog or enable its confirmation.
The template picker follows the existing modal focus/pending-close contract.
The measured 720px grid selector now covers 4–8 samples as well as 1–3.

Both jobs views invalidate background reads when accepting a control ACK. A read
begun before or during that control cannot restore older status/actions or errors.
Research packages also require current allowed access before accepting a late ACK.
Later current reads/failures and authorization denial still apply. Backend/API,
maintenance, original request identities and accepted-operation protocols remain
unchanged.

## Actual checks and retained failures

Counts below overlap; they are not an aggregate count of independent cases.

| Check/source | Actual result | Evidence |
| --- | --- | --- |
| Default focused V21, `4479295` | 11 passed; restore case 3,091ms versus observed pre-fix 4,667ms | `/tmp/ci-v21-fixture-fixed.log`; default 5,000ms, existing separately timed native-byte case retained; not a production benchmark |
| Settings/data first-read checks | 21 passed, 3.25s | `/tmp/phase5f-settings-read-check.log` |
| Processing preview, Process/Timeline, modal | 57 passed across 3 files, 6.92s | `/tmp/phase5f-processing-focused.log` |
| Mocked Processing confirmation | 6 passed, 2.78s | `/tmp/phase5f-processing-confirm.log`; no real backend confirmation qualification |
| Helpful read-conflict repair, `0512763` | 47 passed across 2 files, 4.30s | `/tmp/phase5f-read-conflict-regression.log` |
| Receipt-owner repair, `b7c6246` | 56 passed across 3 files, 4.82s | `/tmp/phase5f-package-receipt-focused.log` |
| Full mounted, `b7c6246` | 92 files/863 passed, 142.16s | `/tmp/phase5f-full-mounted.log`; precedes jobs-view repair |
| Jobs-control baseline at unchanged `b7c6246` | 12 failed/0 passed, 2.27s, 20:01:42 UTC | `/tmp/phase5f-jobs-control-baseline-red.log` |
| Initial two-page jobs-control repair | 86 passed across 5 files, 5.73s | `/tmp/phase5f-jobs-control-focused.log`; before added denial guard |
| Added current-403/late-ACK baseline | 13 passed/1 failed, 2.36s, 20:04:14 UTC | `/tmp/phase5f-jobs-access-baseline-red.log`; research ACK overwrote denial with false saved status |
| Final guards, `3c1baf5` | 88 passed across 5 files, including 14 new cases; 5.36s | `/tmp/phase5f-jobs-control-final-focused.log` |
| Full mounted, `3c1baf5` | 93 files/877 passed, 137.10s; start 20:04:49 UTC | `/tmp/phase5f-final-full-mounted.log`; `taskset -c 0,1 npm run test:reference-mounted`, no timeout override |
| Final local rebuild, `3c1baf5` | Exit 0; TypeScript and Worker/client artifacts built | `/tmp/phase5f-final-build.log`; `taskset -c 0,1 npm run build`, local config, no deploy |
| Final Map performance, `3c1baf5` | Run `37984549655` succeeded, 20:05:26 UTC | Exact-head remote result; separate from complete Verify |
| Final complete Verify, `3c1baf5` | [Run `37984549600`](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37984549600), job `114003140535`, SUCCESS; all 15 contexts SUCCESS | 20:04:49–20:30:28 UTC, 25m39s; canonical 12-leaf gate qualified, no remote test-count claim |

The final build's raw log retains a nonfatal Wrangler logging ENOENT when creating
`/home/agent/.config/.wrangler`; it completed and exited 0. It is not a build
failure or a warning-free run.

`/tmp/phase5f-3c1baf5-local-checkpoint.json` pins the clean code head/tree, commands,
outcomes and exact artifact hashes; SHA256
`f87bac72f5c2a43281f2d766bec1ce3385b30dcde8434c6ef83fe4805b95140d`.
The retained red-baseline log hashes are respectively
`11aba5e32c2a85ff31b90d612480da549350d91ea8e115b217b49550f87537ec`
and `831bd43bde04177ac6be424615c784d62cfba6e7fa3e40724fe16a98eb24510b`.

## Default-CI history

| Head/check | Observed outcome and implication |
| --- | --- |
| `2060c74`, Verify `37918377223` | V21 recovery failed default 5,000ms. Earlier local source qualification used 15,000ms. |
| `4479295`, Verify `37976554667` | Cancelled at 20-minute job budget; no specific test-failure annotation. Map `37976554666` passed. |
| `20176fc`, Verify `37979239529` | Mounted regression at `src/research-packages.mount.test.tsx:371` removed helpful immutable-media preflight guidance; repaired by `0512763`. |
| `20176fc`, source-only context | `pre-pr/project-foundation` succeeded at 19:37:39 UTC. Exact-head source command/config had no global timeout override; source/V21 counts remain unqualified. |
| `20176fc`, local canonical attempt | Assistant deliberately SIGTERM-stopped the owned native-process tree after the remote regression was established, before source edits. Source-stable exit 1 is incomplete, not a native test failure or complete local pass. |
| `b7c6246` | [Verify `37983032975`](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37983032975) completed SUCCESS; all 15 published contexts, including file-jobs, succeeded. Map `37983032962` succeeded. This qualifies the complete 12-leaf gate for `b7c6246`, not later `3c1baf5`. |

The sequential remote job budget is 40 minutes; default individual-case deadlines
remain unchanged. Strict source proof:
`/tmp/remote-ci-20176-source-context-proof.json`, SHA256
`c58deef479f28ddc9b13c5edcbab6d772f33c857376c6faa0c1bbe6d40caea6f`.
Retain `/tmp/phase5f-complete-default-gate.json` and
`/tmp/phase5f-local-gate-interruption.json`; no new complete local canonical pass
is claimed. Final exact-head workflow success can qualify the complete 12-leaf
gate; its success is now observed without inventing unavailable remote counts.
The actual `b7c6246` completion receipt `/tmp/remote-ci-b7c6246-final.json` pins
successful job `113998030490`, 19:51:10–20:12:24 UTC (21m14s), including its
successful shared-verification step; SHA256
`b41f6c3423543573d04638ab5ccaa5cba002e873e6481cf4800ccca261a340ac`.
It exposes no remote file/test counts. Final `3c1baf5` qualification has its own
receipts: `/tmp/remote-ci-3c1baf5-final.json`, SHA256
`b190ed095463e4d902ebd364aba9a690926ef4501071f4a138a7c06777defcde`,
and `/tmp/remote-ci-3c1baf5-final-contexts.json`, SHA256
`e664c3044117f9316d4842cef7e7000f3992e0bf33562d9b73655ec5dea31fc2`.

## Browser, runtime and data limits

The new isolated clone `/tmp/phase5e-local-k82lCL` uses local Worker/D1/R2 and
`AUTH_MODE=disabled`, Chromium `151.0.7922.173`, height 600 CSS pixels. Historical
SQL fixture extension added four Sample/Run/Step groups, with integrity `ok` and
zero FK errors. Receipt: `phase5f-fixture-receipt.json` under that scratch.
It does not qualify ordinary run creation, native Step 0 or valid substrate
transition. This review did not obtain an independent before baseline for the
original 5E isolated fixture; its preservation is not independently verified here.

| Browser observation | Actual outcome |
| --- | --- |
| Initial dense harness | 12 failed: two server-readiness refusals and ten checks before revealing the scroll button. Retained separately from application width measurements. |
| Corrected before measurement | 12 recorded, not blanket width PASS. At 720px, 3 columns were 88/270px while 4/8 columns were 230/300px; at 721px all were 230/300px. |
| Dense after selector repair | 12/12 passed: 3/4/8 ×720/721 ×light/dark; widths, native scrolling/selection, sticky alignment, overflow, errors and API-write blocking checked. |
| Initial preview harness | Four start cases passed, then false expected-200 assertion received real plan-preview 404; incomplete, no final stability receipt. |
| Qualified preview/focus rerun | 8/8 passed: four real 200 start reads with `canConfirm=false`; four real 404 absent-plan-graph rejection/late-error isolation cases. No successful real plan preview or confirmation qualification. |

Reports are under the scratch directories `phase5f-dense-before-1791572923769`,
`phase5f-dense-before-1791573009046`, `phase5f-dense-after-1791573076872`,
`phase5f-preview-focus-1791573130154` and `phase5f-preview-focus-1791573342928`.
The preview repair preserves the real historical null-plan rejection and permits
only exact read-only POST preview endpoints plus ordinary reads; mutations abort.
Original/repaired harness SHA256:
`7a9f1b17be966bdd142ed838fb615d8348547d12e2fffcc6192e426aacb41f68` →
`70e5e0bdf41fb46041f3cc6525de7d43627a7f01b9354c681f2a9bd9d0c9d542`.

The `b7c6246` expected-diff runtime review
`/tmp/phase5f-runtime-inputs-current-closure.json` is pinned by SHA256
`0e6aaece55ac8ef839f4ff228f9d486013dfab63bf8345bc60b23c0bedd32f33`.
It reconstructs matching dense/preview source windows and records 1,257 public/
1,127 eligible code files, 7,495 unchanged installed/runtime hashes and one
legitimately changed Vitest results cache among 7,496. This is a hash review, not
a browser rerun. Later package/jobs-view changes are not retroactively browser
qualified. Root dotfiles, complete browser support assets and full OS/kernel/
system-library closure are excluded. Final Git/source-byte closure is complete in
`/tmp/phase5f-3c1baf5-source-delta.json`, SHA256
`a99d10c0d940c15f4e0caa7895482304e3441358dc4279243caa352e62fef949`:
only the two jobs-view pages and new jobs-control test differ from `b7c6246`;
current bytes match the clean head/tree. Processing and styles equal the recorded
`20176fc` browser code. This is not a dependency rehash or browser rerun and does
not retroactively browser-qualify the later package/recovery repairs.

The isolated server received TERM; exec session `73262` exited 143, not graceful
exit 0. Final actual development-data proof is read-only and matches schema,
typed cells and physical rowids, quick-check `ok`, zero FK errors:
`/tmp/phase5f-development-data-final.json`, SHA256
`8e33a8ba27a505779322c50f3c680c376066cd1ac2e877e501d457521baae13f`.
Mutable `/tmp` evidence supports this checkpoint; retain the reviewed record and
necessary immutable receipts in the repository or a durable artifact.

## Remaining exits

The frozen bounded code batch and its default-CI exit are complete. PR #250's
historical docs head `1fe8dd6`
had four green check runs and 14 green contexts at 19:47 (Draft/CLEAN), recorded
in `/tmp/pr250-current-checks-1947.json`. Its new docs head
`4b7353ad8c792d790d379df0e38cbfba04730fb5` has four successful own runs and 14
successful contexts, Draft/CLEAN/MERGEABLE, recorded in
`/tmp/pr250-4b7353a-final-checks.json`, SHA256
`ef7b868fad696608fea0fd0b0cb077e3e37f03b402b8b701302e6eaeec347a7c`.
These qualify that docs head; any later documentation head needs its own checks.
The Cloudflare deployment boundary remains unconfirmed and no merge is recorded.

Next queued slice: [Metrology Save and add goal](PHASE_5F_METROLOGY_GOAL.md), covering
the complete create → entry-add → `onSaved`/refresh chain, continuous pending state,
and session/unmount ownership. Its source is unimplemented and unqualified here.
Whole-5F cross-product review, measured performance,
enabled-scope 6A6/6B, real devices/IME/other engines, authenticated deployment,
real providers, operational recovery admission and release acceptance remain open.
