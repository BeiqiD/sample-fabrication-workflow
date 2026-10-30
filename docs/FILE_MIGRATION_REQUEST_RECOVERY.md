# File Migration request recovery

Local stabilization checkpoint, 2026-10-15. Development baseline:
`1c5bbe0d230b8eb7339d63f1fd471962cb5c17bb`. The adopting PR records its own
hosted checks and development merge separately from these local results.

## Rejected planning and uncertain responses

Previously, a migration intent was saved before POST and cleared only after
success. If another administrator moved a selected File after preview, acceptance
returned 409 but the saved intent permanently disabled fresh planning.

| Observation | Available action |
| --- | --- |
| Exact original receipt found | Reopen that saved job without another POST |
| First attempt returned 409 and its exact receipt is currently absent | Explicitly review a new plan, retaining the earlier request checkpoint |
| An earlier response was lost, malformed or otherwise unconfirmed | Keep the original input and identity; later 409/404 cannot remove that uncertainty |
| Receipt denied, conflicting, malformed or unavailable | Retain the checkpoint and retry only the appropriate read |

**Check original request** performs GET only. **Retry original migration request**
is a separate explicit action: it reads the exact request again before issuing
the same POST if absence is verified. Reload only reconciles saved intent; it
does not replay acceptance automatically.

**Review a new migration plan** first refreshes metadata and checks the original
receipt again. A raced accepted receipt reopens its existing job. Otherwise the
checked original input is retained in earlier-request history before planning
is unlocked. Earlier identities remain available for read-only checks and are
not silently truncated. Storage failures preserve the current pending intent.
An old plain saved input has unknown provenance, so it is never upgraded into a
known rejection. Absence is a point-in-time observation, not cancellation or a
promise that another tab cannot later reveal accepted work.

## Read-only receipt protocol

The privileged `GET /api/files/migrations/requests/:requestId` reads the current
primary and returns `{requestId,input,job}` with immutable input, actor and job
binding. Another actor's existing identity returns 409; revoked administration
returns 403. Lookup does not enable execution, access a provider or write an
acceptance record.

An absent receipt returns HTTP404 with the closed JSON body
`{"schema":"file-migration-request-absent/1","requestId":"..."}` and
`Cache-Control: private, no-store`. The client validates that exact identity.
Generic, malformed and mismatched 404 responses remain errors; an unsupported
old route or intermediary error page cannot unlock replanning.

## Local qualification

- Client: **35 passed**. Existing Migration/Phase5E mounted tests: **39 passed**.
  New request-recovery mounted tests: **33 passed**. The latter cover sticky
  uncertainty, explicit checks/retries, raced acceptance, reload, retained history,
  storage failure, revocation, unmount and owned keyboard-focus transitions.
- SQL/native Worker and contract tests passed; their shared contract cases overlap.
  The final typed-absence change passed four focused cases. Two genuine Node
  HTTP/mount cases passed with the same response protocol. A parallel Node case's
  original five-second timeout remains separate from its unchanged-budget serial
  pass. No production or test deadline was increased.
- Application, server/runtime, export/File and Node File-job type checks passed.
  The actual Worker/client build passed; product inputs remain frozen during
  browser qualification.
- Genuine browser qualification: **2 passed** on the same built Worker
  (`6b9683f5ffa8abd509e9463b60bf98bec5a0085353ffc58afcadd48ad347b585`).
  Desktop 1280/light covers another administrator completing the move, the
  original 409/typed404, explicit replanning and a fresh reverse migration.
  Mobile 390/dark truncates a real committed 202 response, then reloads and
  recovers the original job with exactly one acceptance POST. Three manually
  invoked scheduled events complete these moves. Native readback verifies the
  exact 68-byte PNG, active publications, retained original bytes and foreign
  keys. Both runtime owners and Chromium closed; no page or forwarding errors.
  The only console errors are the deliberately rejected/missing requests and
  truncated acknowledgement. All four screenshots passed width and visual
  checks. Final local receipt: `/tmp/migration-request-recovery-genuine-attempt5/report.json`.

The first two browser attempts exposed qualification-query errors (a publication
column read from the wrong table, then `rowid` on a WITHOUT ROWID table), before
the complete third attempt passed. Subsequent fresh runs improved screenshot
settling/composition; the fifth run is the final source-bound receipt. Earlier
failed and successful receipts remain separate. Product inputs and assertions
were preserved throughout these helper corrections.

The new browser helper uses two isolated local R2 buckets and D1. Historical
installation-profile metadata is an explicit fixture; File creation, authority,
competing migration and job execution use the real public Worker routes.
Scheduled events are invoked manually. This scope does not qualify elapsed
cadence, remote providers, Node SPA, physical devices or deployed version handover.

Repeat after building with the pinned Node version and installed dependencies:

```sh
npm run build
PLAYWRIGHT_MODULE_PATH=/opt/codex/runtimes/cua/lib/node_modules/playwright-core \
CHROMIUM_PATH=/usr/bin/chromium \
CI=true node scripts/qa/phase5f/browser-genuine-migration-intent.mjs \
  --output /tmp/NEW_OUTPUT_DIRECTORY
```

The existing genuine-browser GitHub workflow runs this helper after the two
system-recovery cases. Explicit artifact paths retain only reports/screenshots,
excluding databases, R2 persistence and runtime configuration. Heavy checks stay
local/GitHub; the Cloudflare build path is unchanged.
