# Current development capabilities

Recorded 2026-10-15 against PR #313 candidate `6ca0d8ccc600aeb8b1fbfd59fc5067c64e8a4650`,
merged into development as `860c61d25e6f7e7f30546ea6e1d16e17bc9e28b0`.
This is a development/review ledger, not production activation or release approval.
[PR #313](https://github.com/BeiqiD/sample-fabrication-workflow/pull/313) passed its
four push/PR workflows and fifteen status contexts before that merge. Its hosted
checks and merge receipt remain separate from the local results below.

## Completed backend milestone

The bounded backend interoperability work through PRs #305–#312 is complete in
`v2/backend-foundation`; PR #312 merged as `abdc2d98541c01e887bbea540c50bb07a7e1cab5`.
It covers the recorded nonempty Node↔R2 Package pair, corruption/restart handling,
Worker V5 public/headed/planned cases, Node online/offline consumers, same-app
elapsed scheduling and drain/restart, and the positive planned inert handoff.
Each qualification retains its original source, archive producer, counts and limits.
These results do not establish complete Node self-hosting or deployed-provider acceptance.

## Current product boundaries

| Capability | Supported development behavior | Boundary |
| --- | --- | --- |
| Worker application | Installed SPA and existing Worker application routes | Actual deployed authentication, schema and providers require their own acceptance |
| Worker Storage Settings | Select available R2/S3 destinations for newly accepted uploads | Existing Files keep their recorded locations; selection does not copy historical data |
| File Migration | Explicit verified copy/publication jobs for selected existing Files | Provider availability, execution enablement and deletion protection remain server checks; no implicit migration from changing defaults |
| Research Package | Copy selected research graphs and payloads into a destination with fresh record identities and explicit dependency/naming rules | Package copy is not identity-preserving installation restore; retained immutable definitions follow their declared reuse/conflict rules |
| System Recovery | Validate an installation archive and restore into a qualified fresh target with identity-preserving recovery rules | Protected authority is quarantined/disabled, old jobs do not replay automatically, and target verification is not activation |
| Node V28 shared workflow | Explicitly admitted API routes and File/Package/Recovery runtime composition | Actual capabilities remain `fullReady:false`, `spa:false`, `generalFileLifecycle:false`, `imageBytes:false`; no installed Node SPA or Storage Settings route |
| Node Recovery-only | Native authenticated recovery/backup API and separate offline operator paths | No installed SPA; original-source resume is a separate proven operation, not target activation |

The ordinary Worker source currently produces the V3 archive on its normal schema.
The separately qualified V5 path requires its admitted V28 schema/control state
(`collaboration_control.schema_version = 2`); archive capture selects that branch
explicitly. V3 compatibility and V5 acceptance are distinct. This ledger does not
claim that the ordinary installed Worker has been switched to V5.

## PR #313 recovery frontend policy

Worker requires explicit verified destination-profile mapping. Node retains
source-profile evidence and submits an empty mapping for inert LOCAL staging.
Node backups require fenced, drained maintenance, including historical backups;
maintenance is available without a configured target. A fresh target is still
required for target staging. Node recovery-target/ledger cleanup is unavailable;
eligible backup/upload cleanup keeps its existing admission rules.

Recovery-only Node can explicitly resume the original source after a proven
completed backup/release with the recovery executor paused. The UI retains the
original request, release, backup and generation for lost-response reconciliation.
Maintenance release itself is not a resume receipt. The accepted source-resume
receipt keeps shadow and File jobs paused and makes no binding cutover or job replay.
Shared-workflow Node does not expose that separate source-resume action.

## Verification and the next finite gate

PR #313 local results remain separate: **72 mounted tests**, **42 client/contract/
Worker-route tests**, **two genuine native capability cases**, and **seven local
Chromium cases using explicit HTTP fixtures**. Type checks and Worker/Node builds
also passed. The browser fixtures simulate archives, executor progress and target
proof; they are not genuine browser-driven restore or an installed Node SPA.

**Local genuine Worker browser lifecycle passed.**
The actual current24 V3 path passed at 1280/light and 390/dark with separate local
D1/R2 sources and fresh targets. Each case exercised browser backup, actual ZIP
download/upload, preview, explicit mapping, inert recovery and verified report.
Independent reads checked the observed sample/event rowids and cells, exact PNG
bytes and repaired File binding, original source authority state, and disabled
target execution. Read-only Storage/Migration/Data/Recovery navigation reopened
the original verified report without another mutation. These are two new genuine
local browser cases, separate from PR313's seven HTTP-fixture cases. See the
[qualification and repeatable command](./GENUINE_WORKER_RECOVERY_BROWSER.md).
The follow-on [PR #314](https://github.com/BeiqiD/sample-fabrication-workflow/pull/314)
adds repeatable automation and records its own candidate-specific hosted results;
local passes and PR313's checks do not qualify a later candidate.
Only observed defects require product changes. Keep heavy checks local/GitHub CI;
the minimal Cloudflare bundle/upload path is unchanged.

After that gate and qualified development integration, prepare a reviewable
`main` candidate with an explicit enabled/deferred capability list and ancestry/
handoff notes. Preparing the candidate does not authorize a `main` merge.

## Selected 6A6 / 6B acceptance

Remaining external scope includes relevant physical touch/OS IME, other supported
browser engines, authenticated serving/schema and old-document/new-serving-version
handover, real configured providers and enabled migration/import/recovery operations,
plus operational rehearsal and representative real-data performance. Local fixtures,
structural gates and native factory tests do not substitute for those results.
Unqualified capabilities stay unavailable/deferred under effective server admission.
No production deployment, remote migration, provider activation or real production
File movement is granted by this development checkpoint.

## Reading historical records

Older roadmap sections, the Phase5F baseline map and dated qualification records
retain their original source identities, open items, failures, pending checks and
counts. Their historical Node Package/nonempty-copy gaps must not be read as
current missing implementation after PRs #305–#312. Use this ledger and the latest
dated Product Roadmap checkpoint for current work; do not rewrite old receipts or
combine unrelated test totals into whole5F, complete portability or release approval.
