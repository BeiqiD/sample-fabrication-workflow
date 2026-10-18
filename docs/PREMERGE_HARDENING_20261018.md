# Premerge hardening, 2026-10-18

This review starts from `v2/backend-foundation` at
`3965c90627af91d8e0c680c3aee7fd53e077310c`, after #317. Repairs are prepared on
`codex/pr315-premerge-hardening` for the development branch and, subsequently,
the existing main proposal [#315](https://github.com/BeiqiD/sample-fabrication-workflow/pull/315).
The original main proposal's passing checks qualify its previous inputs; they
are not evidence for the repairs below.

The frozen code repair is commit
`4c855567c874de8e17dc18b1268fd96b1997a45d`, with source-only tree
`8b8fc8ff93d3517610abba1c962333b9556e8b88`. Its 78 changed/new non-document
files were individually checked against the local Git blobs before creating
the commit. A subsequent documentation commit records the completed results;
original local receipts retain the dirty working-tree and baseline identities
that were actually observed when their commands ran.
The [changed-input manifest](qualification/pr315-premerge-hardening/source-inputs.json)
records the individual Git blobs and SHA-256 values.

## Confirmed defects and corrections

| Area | Observed failure | Correction and regression boundary |
| --- | --- | --- |
| Application startup | A denied `localStorage` theme read or write crashed the application outside its route error boundary. | Theme persistence is best effort. The actual mounted App opens and remains usable when storage throws. |
| Retained browser work | After account A lost a response, account B could see A's saved request and use it as B's retry. Module caches also survived identity changes. | Stable account ownership scopes browser checkpoints; the sign-in generation scopes in-memory operations. Old asynchronous work cannot write another owner's storage or send with their credentials. Returning to the original account retains its own records. |
| Authentication across tabs | The browser cookie could change independently of the old page's JavaScript generation. | Authenticated Worker identity reads establish an opaque owner. Worker and Node APIs check an optional expected-subject header before domain handlers. A mismatch returns a fixed private/no-store 409 and invalidates the page's identity. The witness grants no authentication or permission. Node continues to require real sessions and mutation CSRF. |
| Asynchronous browser continuations | A pending receipt lookup, hash or queued attachment could resume before React had unmounted the old account's page. | Capture the owner before preparation/queueing, check it synchronously after asynchronous work, and check it again before retry/upload/publication. Tests retain the old component while changing the authenticated generation. |
| Node comment attachment bytes | The original XHR PUT omitted the existing Node CSRF token, so a saved comment upload could not complete. | The Node byte upload uses the existing authenticated fetch path and redirect restrictions. Worker XHR carries its expected owner. |
| Uncertain storage and recovery requests | A lost original response followed by a rejected retry could clear the old checkpoint even though the original request could still commit. | Only a known first rejection may settle that first attempt. Later retry rejection or a point-in-time missing receipt retains the original identifier and intent for explicit checks. This covers storage registration, activation, defaults, credential reenveloping, maintenance and source resume. |
| Package publication | Actor revocation or a local deadline during the last ownership/verification query could still publish an imported graph or uploaded File. | Local authorization/deadline checks run before and after asynchronous ownership reads and before publication. The verified attempt and source holds remain retained on pause. Four regressions failed before the repair. |
| File migration and cleanup | The same late change during an ownership/grant query could cut over a File or release its source hold to GC. | Both migration and cleanup recheck synchronous authorization, deadline and abort state after the awaited query. Four regressions verify retained source publication/holds, verified bytes and no duplicate PUT. |
| Recovery backup publication | The backup write branch published `completed` immediately after `verifyAttempt`, without the fresh check already present in the other branches. | The final `current()` now precedes `finish`. Actor/deadline regressions retain the verified artifact while paused and complete after explicit resume using the original key and one total PUT. |
| Original S3 request settlement | Source failure could reject the writer while the original provider request or permission guard remained pending. | Start all cancellation operations, then join the original pump, provider/guard and cleanup promises before releasing stream locks. Native workerd regressions hold those original acknowledgements to prove that the writer does not finish early. |
| CI qualification | Browser and migration readiness checked the PR head alone, and bootstrap/helper-only changes could skip the gates. Old and new builds also shared a dependency installation. | Qualify `github.sha`, the actual PR merge candidate, add missing trigger paths, install each version from its own unchanged lock and run it with its own Miniflare. Record both dependency input identities. |
| Offline archive bundle compatibility | The patched Sharp dependency imports `createRequire` in ESM. Eight older bundling entry points injected the same top-level name in a banner, causing syntax failure in actual isolated restore tests. | Give the injected import a dedicated alias in four native qualification helpers, three offline archive CLIs and one QA parser. Keep the require shim and every original restore/data-preservation assertion unchanged. The independent Node distribution already used an alias. |

The fixes retain the existing product capability boundaries. They introduce no
new Node SPA/storage-selector capability, automatic File migration, target
activation, source binding change or replay of restored jobs.

## Older browser records and upgrades

An old client did not record a verified owner. Its unscoped records therefore
remain saved separately and are not silently assigned to the next account. The
application explains this and directs the user to review saved work with the
original account. It does not show another owner's retained intent as retryable.

The actual two-version rehearsal keeps version A fixed at
`abdc2d98541c01e887bbea540c50bb07a7e1cab5`. A genuinely accepted export with a lost
A response remains in the authenticated account's server job list after upgrade.
The B case checks that read-only discovery, retention of the unowned original
checkpoint and zero mutation replay. It no longer claims automatic adoption of
an ownerless checkpoint. New-version reload/reconciliation remains separately
covered by genuine Package and Migration browser cases using owner-bound keys.

The shared browser inspection helper reads the actual `/api/identity` response,
validates its schema/subject and observes the resulting storage namespace. It
does not insert an owner into test checkpoints or rewrite the old application's
data to make the handover pass.

## Dependency repairs

The initial npm report contained 14 affected package groups: 10 high and 4
moderate, including development tools, transitive dependencies and repeated
advisory paths. This is not a count of demonstrated production exploits.

| Dependency | Previous locked version | Repaired locked version |
| --- | --- | --- |
| Hono | 4.12.31 | 4.13.7 |
| React Router / DOM | 7.18.1 | 7.18.2 |
| Vitest and its packages | 4.1.10 | 4.1.11 |
| xmldom | 0.9.10 | 0.9.12 |
| Cloudflare Vite plugin | 1.45.1 | 1.49.0 |
| Wrangler | 4.112.0 | 4.116.0 |
| Miniflare | 4.20260714.0 | 4.20260730.0 |
| workerd | 1.20260714.1 | 1.20260730.1 |
| Workers types | 5.20260719.1 | 5.20260730.1 |
| Undici, scoped to this Miniflare | 7.28.0 | 7.29.1 |
| Sharp, scoped to this Miniflare | 0.34.5 | 0.35.5 |
| PostCSS | 8.5.20 | 8.5.23 |
| nanoid | 3.3.16 | 3.3.18 |
| source-map-js | 1.2.1 | 1.2.2 |

The plugin, Wrangler and Miniflare are pinned together deliberately. The
[plugin 1.49.0 metadata](https://registry.npmjs.org/@cloudflare%2fvite-plugin/1.49.0)
uses the stable Miniflare 4 combination; its
[1.49.1 successor](https://registry.npmjs.org/@cloudflare%2fvite-plugin/1.49.1)
introduces Miniflare 5 alpha. This repair does not adopt that unrelated runtime
transition. [Wrangler's metadata](https://registry.npmjs.org/wrangler/4.116.0)
requires the corresponding Workers types. The stable
[Miniflare metadata](https://registry.npmjs.org/miniflare/4.20260730.0) still pins
affected Undici/Sharp versions, so narrowly scoped overrides replace those
resolved dependencies. Merely accepting npm's suggested Miniflare version
would not have corrected those paths.

An isolated install, complete dependency graph check, actual Sharp PNG
encode/decode, native Worker/D1/R2 smoke and real CLI invocations passed before
the candidate was adopted. The shared working tree was then independently
installed from the new lock using the local cache with audit disabled.

Automatic approval rejected `npm audit fix` because of the full dependency-list
disclosure to the audit service. The approved alternative used public package
metadata GETs with `--no-audit`, without sending the dependency tree to that
service. Local comparison against the original report finds no remaining match
for its 45 direct advisory range entries. The old aggregate Miniflare range
describes its vulnerable defaults; the actual resolved children now use the
patched overrides. **This comparison is not a fresh zero-vulnerability audit.**

Dependency inputs:

- `package.json` SHA-256: `3bb2d1368f2d41dac4c4d54688d305f14fa4a175518f2505ffcce9c27f53ac50`.
- `package-lock.json` SHA-256: `b2a1922654dc60757c012bcc310548393cbe67aa77f4bb3ed21644ff79037fb0`.

The npm override changes Miniflare's installed Undici, not Node's built-in
library. Node remains pinned at `24.19.0`, with built-in Undici `7.29.0`.
The matching original advisories concern optional WebSocket, retry,
interceptor or BalancedPool APIs; a search of production `server`, `shared`
and `worker` source found no use of those APIs or a replacement global
dispatcher. This establishes no reachable defect for those advisory paths,
and does not claim that the entire Node runtime has no vulnerabilities.
The [scope record](qualification/pr315-premerge-hardening/builtin-undici-scope.json)
retains the individual advisory URLs and the search boundary.

The [original dependency report](qualification/pr315-premerge-hardening/dependencies-before.json),
[candidate range analysis](qualification/pr315-premerge-hardening/dependencies-candidate-analysis.json)
and [native dependency smoke receipt](qualification/pr315-premerge-hardening/dependencies-native-smoke.json)
are retained with this review.

## Verification record

The final isolated `VERIFY_PUBLISH_STATUSES=0 npm run verify:ci` exited **0**:
all **16 required leaves passed** on the frozen repaired inputs. No test was
skipped in its four test-suite leaves. The
[complete-gate receipt](qualification/pr315-premerge-hardening/verification-summary.json)
records each leaf's result/duration, runtime, input identity and closed log hash.

| Complete final gate | Observed result |
| --- | --- |
| Verification scripts and shared dependency boundary | 357/357 tests; 145 shared source files checked |
| Source tests | 435/435 files; 4,052/4,052 tests |
| Mounted frontend tests | 110/110 files; 1,166/1,166 tests |
| Genuine Node HTTP tests | 30/30 tests |
| Type checks | Application, server/runtime tests, export contracts and Node File-job runner passed |
| Builds and bundle checks | Node client, production Worker/client, rich text and Project Map passed |
| Native migration and built Worker checks | D1 migration, reference, reference-search and final Project Worker artifact leaves passed |

The actual final production artifact checks include API health, SPA fallback,
JavaScript serving, Access rejection and distinct reference creation. The
complete gate preserves its original verification plan and assertions.

The following focused results establish the individual repairs and their
failing-before evidence. Their counts overlap the complete gate and should not
be added to it as extra unique tests.

| Completed local check | Observed result |
| --- | --- |
| Package repository regressions | 19 passed, including four new failing-before cases |
| Package nonempty round trip and scheduled runtime | 10 passed |
| File migration kernel | 25 passed, including four new failing-before cases |
| Recovery runtime and routes | 22 passed, including two new failing-before cases |
| S3 adapter and native request/stream lifecycle | 65 passed in four files, including two new held-acknowledgement cases |
| Worker identity and existing subject scope | 8 passed in two files |
| Node identity over genuine local HTTP and SQLite | 16 passed, including two new failing-before cross-tab and witness-admission cases |
| Comment queued/hash owner continuation and existing acceptance | 12 passed in three mounted files, including two new failing-before cases |
| Project trash owner continuation and existing hook/page behavior | 24 passed in three mounted files, including two new failing-before cases |
| Populated migration under the repaired lock | All three actual Wrangler/workerd scenarios passed: incremental 17→24, direct 17→24, migration-19 ledger fault and unchanged-SQL retry |

### Genuine browser acceptance

All four final browser wrappers passed, with **eight cases and zero failures**.
The current production Worker/client build also completed successfully. The
run used Playwright Core `1.57.0` and Chromium `143.0.7499.0`; the old A build
kept its original source and dependency lock. Each report was checked for
successful cases and complete closure of its original runtime/browser owners.

| Wrapper | Final result and exercised behavior |
| --- | --- |
| Two-version handover | 2/2: desktop/light and mobile/dark; real retired JS/CSS failure, explicit keyboard reload, retained unowned checkpoint, authenticated discovery of the originally accepted job and no mutation replay |
| Genuine Worker Recovery | 2/2: real nonempty backup, download, upload, preview, explicit mapping, inert recovery and report verification over native D1/R2 |
| Genuine migration intent | 2/2: another administrator's completed migration causes the actual 409/404 replan path; an actually committed request with a lost acknowledgement recovers by exact GET without another POST |
| Genuine Worker Package | 2/2: real ZIP export/validation/copy with fresh graph and File identities, source retention, existing-import reuse and committed-import acknowledgement loss recovered after reload without another POST |

The [browser summary](qualification/pr315-premerge-hardening/browser-summary.json)
links all four unchanged reports by SHA-256 and records the successful original
owner/port closures. These are actual isolated signed-Access Worker and
Chromium flows. Scheduled events were explicitly dispatched by the existing
acceptance harness; the runs do not establish elapsed production cadence.

### Complete-gate environment and fixture corrections

The first broad run exposed a real ESM bundle collision from the dependency
repair; the eight alias changes above corrected it. A subsequent source run
also exposed the environment's existing `/workspace` mode `0777`. The existing
identity/key-directory tests correctly reject a writable ancestor. A dedicated
private directory under `/root`, mode `0700`, was therefore used for the final
complete gate, with its own physical dependency installation and matching
source inputs. No global directory permissions or production/fixture security
guards were relaxed. All eight previously affected suites passed there,
covering 50 tests before the complete run.

Three frontend test fixtures also needed to match the repaired behavior. The
reference-source integration assertion now requires the actual owner guard in
the load callback's dependencies while retaining the original query/history
checks. The two existing App fixture files now provide a real valid identity
response for each authenticated generation. Their original permission,
read-only, StrictMode cancellation, late-response and unmount assertions remain,
and request-subject assertions were added. No production change was made to
accommodate these old fixtures. The final two mounted fixtures were synchronized
to the private copy before its mounted leaf began.

### Final Node distribution

The final complete gate's Node client output was reused for the final Node
distribution build. `build-node`, the distribution's embedded integrity/runtime
verifier and all four actual compiled CLI `--help` invocations passed. Each CLI
returned nonempty help, exit code 0 and no stderr. The separately required
`node-distribution-v28.test.mjs` contract suite also passed all eight cases.

The final distribution contains 124 inventory files, with all 989 declared
source inputs checked against the final private copy and shared repaired tree.
Its refreshed manifest SHA-256 is
`027eb62666682671334df06560c5a6c396e9510bf844b9bb73fb421f58d5fd4d`.
The final fixture corrections are included in this refreshed input manifest.
The [distribution receipt](qualification/pr315-premerge-hardening/node-distribution.json)
records the actual build, verifier, compiled executable and source hashes.
This is local Linux x64 / Node `24.19.0` build and runtime qualification within
the existing restricted development capability scope.

### Populated migration acceptance

The repaired-lock migration run retained 20 complete snapshots, 49 original
owner closure records and 14 actual Wrangler CLI results. Only the deliberately
injected migration-19 failure is expected: migration 18 stays committed, 19's
DDL/ledger rolls back and the original 19–24 files succeed on retry. Reopen,
no-op and preserved cells/rowids remain required. Reports state the dirty
working-tree status and actual dependency hashes rather than claiming that the
baseline commit contains the repairs. No published migration SQL was changed.

The existing native D1 global `quick_check` boundary remains visible: 12 of the
20 snapshots returned `SQLITE_NOMEM`, while eight returned `ok`. All 20
completed table-level native checks, followed by full-database `quick_check=ok`
and zero foreign-key violations after the original proxy closed and its actual
persisted SQLite file was reopened read-only. The
[migration summary](qualification/pr315-premerge-hardening/migrations-summary.json)
retains the original command and closure counts; these results do not claim
that all 20 native global checks succeeded.

## Release boundary

This is a software premerge review. Actual main integration, deployed Access
and provider qualification, remote migration, production activation, physical
device/OS IME and representative real-data performance retain their separate
decisions and evidence. Heavy verification remains local or in GitHub Actions;
the Cloudflare build/upload path stays separate from remote migration.
