# Recovery frontend supported matrix

This development slice follows the bounded backend integration in PR #312
(`abdc2d98541c01e887bbea540c50bb07a7e1cab5`). It changes capability metadata and
frontend behavior, not archive formats, target activation or storage migration.

| Operation | Worker | Node Recovery-only | Node shared workflow |
| --- | --- | --- | --- |
| Destination mapping | Explicit verified profiles | Empty mapping; retain source evidence, inert LOCAL staging | Same inert staging policy |
| Historical backup maintenance | Optional | Fenced and drained | Fenced and drained |
| Planned backup maintenance | Fenced and drained | Fenced and drained | Fenced and drained |
| Enter maintenance without target | Unavailable | Available | Available |
| Recovery target cleanup | Existing eligible cleanup | Unavailable; retain target and ledger | Unavailable; retain target and ledger |
| Backup/upload cleanup | Existing eligible cleanup | Existing eligible cleanup | Existing eligible cleanup |
| Explicit original-source resume | Unavailable | Available after backend proof | Unavailable; workflow owns source release |
| Installed SPA / Storage Settings | Worker SPA; available R2/S3 upload defaults | No installed SPA | `spa: false`; no Storage Settings route |

Every capability response includes a checked `policy` object. The client does
not infer runtime policy from target configuration or profile count. Client and
server changes ship together. Old cached clients reject the new strict response
until reloaded; new clients likewise reject servers without policy rather than
guessing a destructive action's meaning.

## Original-source resume

Entering maintenance pauses source authority, shadow conversion and file jobs.
Releasing the window changes maintenance state only. In Recovery-only Node,
resuming source writes is a separate explicit operation bound to the original
accepted release, completed backup and generation. Pause the recovery executor
and let accepted work settle first. The backend still proves the original LOCAL
installation, archive contents, unchanged checkpoint, current administrator and
drained writers; visible UI prerequisites do not replace that proof.

The browser retains those original identifiers before POST. A lost or invalid
response remains unconfirmed. On reload, current administrator access is checked
before looking up the exact original receipt; only an explicit retry may replay
the same input after a missing receipt. Maintenance state alone is never a resume
ACK. An accepted receipt enables original source writes while keeping shadow and
file jobs paused, with no binding cutover or historical job replay.

The page waits for its active reads before source resume and suspends polling
during that operation. Other job controls retain their existing concurrent status
reconciliation. This preserves native resume's exclusive Recovery ownership
without relaxing server admission or drain checks.

## Verification boundaries

- Contract and client tests reject unknown policy and mismatched source-resume
  identities, altered generations and malformed/activation-claiming receipts.
- Mounted tests cover both mapping policies, no-target backup fencing, unsupported
  cleanup, executor prerequisites, lost responses, explicit original retries,
  generation changes, revocation, request exclusion and keyboard focus.
- `scripts/qa/phase5f/browser-supported-recovery.mjs` serves the actual built
  client against explicitly checked local HTTP fixtures. It covers desktop/light
  and mobile/dark layouts, nonempty profile evidence and exact submitted mapping,
  backup maintenance, keyboard focus, source-resume lost ACK/reload, and revoked
  administrator state. Archives, executor progress and target proof are simulated
  in this browser harness; it is not genuine Node/Worker restore acceptance.
- Native capability qualification uses the actual Node factory/authentication,
  separately from these browser fixtures. Earlier genuine backup/recovery and
  handoff acceptance remains attached to its original recorded source scopes.

Run the focused native capability check from the repository root on Linux with
the pinned Node version and installed dependencies. Use a private fixture parent
under trusted, non-writable-by-others ancestors, outside `/tmp`; the real writer
lease rejects world-writable ancestors. Read the filesystem root UID inside the
same execution context that runs Vitest (sandbox and host UID views may differ):

```sh
mkdir -m 700 /workspace/recovery-policy-fixtures
CURRENT_V28_CANONICAL_COMMENT_FIXTURE_PARENT=/workspace/recovery-policy-fixtures \
NODE_PROTOTYPE_FILESYSTEM_ROOT_OWNER_UID="$(stat -c %u /)" \
npx vitest run --config vitest.recovery-policy.config.ts
```

Choose a fresh fixture-parent path if that directory already exists. The two
cases passed locally on 2026-10-15 using the actual source factories, local
authentication, loopback HTTP, SQLite and original writer/close ownership. They
check Recovery-only no-target policy, an ordinary account's denied capabilities,
and borrowed workflow policy with source-resume refusal. They do not perform a
compiled-CLI, backup/restore or elapsed scheduler-cadence qualification.

No physical-device, other-engine, deployed-provider or installed Node SPA result
is inferred. A later release candidate must review those relevant deployment
boundaries separately. This slice keeps the existing minimal Cloudflare build.

## Local development verification (2026-10-15)

The affected mounted suites passed 72 tests across three files; the client,
shared-contract and Worker-route suites passed 42 tests across three files.
Application and server/runtime-test type checks, Worker build, Node client build,
and the closed offline distribution manifest check passed. The genuine native
capability suite passed two source-factory cases, separately from compiled-main
or full archive acceptance.

The browser helper passed seven Chromium 151.0.7922.173 cases on Node 24.19.0.
At 390/dark and 1280/light, document width matched the viewport and the deferred
backup preview restored visible keyboard focus. The lost-ACK scenario made one
original resume POST and one exact receipt GET after reload. Expected truncated
response and denied-access diagnostics are distinguished from unexpected page
errors. Fixture maintenance follows generation 0 → enter 1 → finalize 1 →
release 2. The browser and local fixture server closed after the run.

Repeat the bounded UI checks with the repository's installed dependencies:

```sh
npm run typecheck
npm run typecheck:server
node_modules/.bin/vitest run --config vitest.mounted.config.ts src/system-recovery.mount.test.tsx src/phase5e-settings-data.mount.test.tsx src/phase5f-jobs-control.mount.test.tsx
node_modules/.bin/vitest run src/lib/system-recovery-client.test.ts shared/contracts/system-recovery.test.ts worker/recovery/routes.test.ts
npm run build
npm run build:node-client
```

The optional browser helper uses an existing Playwright Core and Chromium;
it does not download browsers. Point the two variables to installed binaries,
then choose a new evidence directory outside the checkout:

```sh
PLAYWRIGHT_MODULE_PATH=/opt/codex/runtimes/cua/lib/node_modules/playwright-core \
CHROMIUM_PATH=/usr/bin/chromium \
node scripts/qa/phase5f/browser-supported-recovery.mjs \
  --client dist-node/client --output /tmp/NEW_OUTPUT_DIRECTORY
```
