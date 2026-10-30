# Main integration readiness

Review checkpoint, 2026-10-18. Current development base:
`3965c90627af91d8e0c680c3aee7fd53e077310c` (`v2/backend-foundation`, including
[PR #317](https://github.com/BeiqiD/sample-fabrication-workflow/pull/317)).
The current main proposal is the open, non-draft
[PR #315](https://github.com/BeiqiD/sample-fabrication-workflow/pull/315).
Its base is `main` at `1788c1958b35ef6e3df917ec17d6ef13503b0ffe`; the observed
combined candidate is `114f6dfeeb93d7eb0b1547b6d773cf27532c0f5f`.
At review start, the development head and that combined candidate each had
fifteen successful status contexts, and the four main-target workflows had
succeeded. These results qualify that baseline, not the subsequent repairs.

The additional repairs are on `codex/pr315-premerge-hardening`, with frozen
code commit `4c855567c874de8e17dc18b1268fd96b1997a45d`.
Its [repair and validation record](./PREMERGE_HARDENING_20261018.md) supersedes
older pending-status descriptions while preserving their original evidence.
All 16 complete local verification leaves passed, together with eight genuine
browser cases and three populated migration scenarios under the repaired lock.
Hosted checks belong to each actual pushed/PR candidate and are recorded on its
repair PR; the original #315 checks above do not qualify these additional inputs.
The review does not authorize the main merge or operational release.

## Prior software qualification (2026-10-15)

The following table and detailed local results describe the earlier checkpoint
from `5206eb34c7b890af5bcae6db4df158d3d2bf18c3`, later integrated through #317.
Its pending labels are historical and do not describe the current repair branch.

| Gate | Current result |
| --- | --- |
| Package and Recovery uncertain acceptance | The confirmed checkpoint-loss regressions are corrected. Focused tests and independent review passed, including async denial, older polls, damaged history and source-versus-copy labels. Final hosted qualification remains separate. |
| Original-request absence protocol | Request-bound closed JSON404 envelopes, actor/privacy and authorization/lifetime fences are implemented. Focused backend/native qualification is recorded separately below. |
| Genuine Package browser copy | Two genuine Chromium cases passed: nonempty Sample/Project/PNG browser ZIP export, upload/validation, copied import and native identity/byte verification; ordinary reuse and committed-import ACK-loss recovery. |
| Two actual build versions | Two genuine Chromium cases passed across independently built `abdc2d98` and the current build: real retired lazy JS/CSS, explicit focused recovery/reload and original accepted-request continuity across sequential runtime replacement. |
| Populated current-chain upgrade | Three actual installed local Wrangler cases passed: populated prefix17→24 ladder, direct unchanged suffix, and partial-prefix failure/exact retry, with data/ledger preservation and no-op/reopen. |
| Final exact source | Ten production inputs are frozen; the third build, focused type checks and independent product/workflow review passed. Own hosted workflows/statuses and qualified development integration remain pending. |
| Main proposal | Pending: fresh main/development ancestry, license and combined-tree audit, updated capability scope and the proposal's own main-target CI. |

## Request recovery boundary

A lost or malformed response remains uncertain across retries and reloads. Old
plain checkpoints also have unknown provenance. A later rejection or missing
receipt cannot erase that earlier uncertainty. Checking an original request is
read-only; retrying it is a separate explicit action that first reads its exact
receipt. Only the expected request-bound absence DTO permits the retry path.
Generic404 responses and unsupported older routes keep the checkpoint.

Replanning after a definitive first rejection is explicit and retains the complete
earlier intent for later read-only checks. A raced accepted receipt reopens its
existing work. Absence is a point-in-time observation, not cancellation or a
promise about another tab. Package's actor-scoped request namespace and valid
reused-import receipt semantics remain intact. Maintenance and original-source
resume keep their independent protocols.

## Qualification records

The two original pre-fix mounted probes are preserved separately:

- Package: one failed, zero passed, forty skipped; exact-source mocked transport
  loss, GET404, same-input POST409, GET404. The checkpoint became null and replacement
  controls became available.
- Recovery historical backup: one failed, zero passed, thirty-seven skipped;
  the same bounded sequence lost its original checkpoint. These probes do not
  establish actual backend/browser execution or passing acceptance.

The 2026-10-15 backend qualification: **132 passed** across the four focused contract/
Worker-route files, plus **two genuine Node Recovery HTTP cases passed**. Those
counts retain their own scopes. Server and Node File-job type checks passed.
Package qualification: **76 client** and **78 mounted** cases passed. Recovery:
**40 client**, **68 recovery mounted** and **21 mixed-page mounted** cases passed.
Each file/count keeps its own scope. The independent review caught and verified
post-hash/ZIP denial fences, original-request/older-poll ordering, malformed-history
admission and truthful export-source/import-copy links before the final freeze.

The final application build and types passed. Its ten product-input hashes and
client HTML/lazy-module identities bind local results to their actual build;
the Worker hash alone cannot distinguish a frontend-only change. The existing
genuine Recovery lifecycle passed both desktop/mobile cases on the second build,
whose Recovery inputs remain unchanged in the third build. New third-build
Package and handover results are described below. Hosted checks must still qualify
the committed candidate and its actual main-target proposal independently.

The genuine Package cases used the third build at 1280/light and 390/dark. An
actual 32,806-byte STORE ZIP contained fourteen records and one valid 68-byte PNG.
Native comparisons covered thirteen business rows and seventeen identities,
fresh roots/File, remapped Sample reference, literal Markdown, naming/provenance,
accepted destination policy and retained source cells/rowids/bytes. Project Reading
rendered the copied Markdown, reference and decoded PNG. Read-only cross-page
navigation made no mutation. Desktop reuse returned the existing import without
another graph; mobile lost a real committed202 response, reloaded and found the
original job by GET with exactly one import POST. Scheduled handlers were manually
dispatched five times per case; elapsed deployment cadence was not tested.

The handover cases used two independently built versions, the same signed local
identity and persisted D1/R2 state, and sequentially closed/opened actual owners.
Old JS and CSS received the new SPA HTML200 response and failed real MIME loading.
The alert owned focus; one explicit keyboard reload preserved full URL and theme.
Mobile recovered an original queued Package request by GET with one original POST
and no replay. Schema, ledger, selected canonical rows and source bytes remained
unchanged; execution stayed paused. Runtime ports, edge/JWKS servers and Chromium
closed. This establishes the named local schema-compatible handover only.

The populated Wrangler run used Node24.19.0, Wrangler4.112.0 and workerd1.20260714.1.
All three scenarios passed using unchanged reviewed SQL. Fourteen actual CLI
processes closed: thirteen succeeded and one hit the deliberately injected ledger
fault at migration19. Migration18 remained committed, migration19 DDL/ledger rolled
back, later files had not run, and identical19→24 SQL succeeded after removing only
the fixture fault. Twenty typed snapshots and forty-nine proxy/read-only-owner
closure records cover the ladder, direct suffix, reopen and no-op. Final snapshots
contain130 application/local tables and133 physical health-check tables. Synthetic
fixtures cover legal legacy-authority retention; they do not bypass admission to
acquire native File holds. Failed earlier QA attempts retain their original scope.

## Local D1 health-check boundary

The installed local workerd returned `SQLITE_NOMEM` for global `PRAGMA quick_check`
on the populated prefix20 fixture. Its actual closed SQLite file passed global
quick-check and foreign-key checks; the migration CLI itself had succeeded.
Original failed reports and the independent diagnostic remain separate evidence.

The upgrade helper requires native global foreign-key checks and enabled foreign
keys, enumerates physical tables and checks each natively, and permits an authorizer
refusal only for the exact protected engine table `_cf_METADATA`. After disposing
the original proxy/CLI owners, it opens the actual persisted database read-only
and requires complete physical-table coverage, global quick-check and foreign-key
health. Any other unexpected native failure remains a failure. This records the
local native-query limitation explicitly; it does not claim that the failed global
native query passed, change migration SQL or establish remote D1 health.

## Scope retained for operational release

The supported software proposal retains the existing Worker SPA and bounded
Node API/CLI profiles. Node still advertises `fullReady:false`, `spa:false`,
`generalFileLifecycle:false` and `imageBytes:false`. Complete Node hosting and a
Node storage-selector UI remain separate work.

The checked-in Worker trigger remains the daily `17 3 * * *` invocation. Named
local browser cases manually dispatch scheduled events; they do not establish
a deployed two-minute cadence. Operational enablement needs an independently
configured and qualified invoker, matching storage profiles and explicit current
executor admission. Defaults do not move existing Files, activate a recovery
target or replay restored jobs.

Physical touch/OS IME, other supported browser engines, authenticated deployed
Access/serving/schema handoff, actual provider configuration/outages, production
migration/activation and representative real-data performance keep their own
release evidence. Local native/browser checks do not close these external gates.
Cloudflare keeps the existing single-build/upload path; heavy checks remain
local or in GitHub Actions. Preparing a merge-ready software proposal leaves
the actual main merge and operational publication to their authorized decision.
