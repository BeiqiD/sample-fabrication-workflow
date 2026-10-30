# Integrated development browser acceptance

Checkpoint: 2026-10-10 (UTC), source
`af8f374cfbbade3282f2e686cc9f35d3c40adf4a`, tree
`087749d12a3e3ad19473f1f4e63d29e1ecf1c269`.
[PR #251](https://github.com/BeiqiD/sample-fabrication-workflow/pull/251)
merged into development at `aa497d9a1a304751ea7533548573a256799ef734`
at 13:30:26 UTC. The observed merge tree equals the qualified source tree.
This record qualifies that checkpoint; later source changes require their own
evidence. It does not close all of Phase 5F, 6A6/6B or the later roadmap.

## Complete integration gate

The unchanged default `npm run verify:ci` passed all 12 leaves locally:
355 native tests; 366 source files / 3,349 tests; 98 mounted files / 945 tests;
no skips. Contracts, fresh/populated migrations, reference Workers, build,
Map bundle and production Project Worker artifact checks also passed.

All four exact-head remote runs and all 15 final status contexts succeeded:
[push Verify](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054290373),
[PR Verify](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054322488),
[push Map](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054290357),
[PR Map](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054322490).
Duplicate workflows temporarily overwrote the shared commit contexts with pending
states; merge waited until both Verify runs and all final contexts completed.

## Actual local browser matrix

The clean committed build was copied to a new private directory with fresh
local D1/R2 state. No existing development data was copied. All 22 ordinary
migrations and a valid Step 0/two-version Process fixture were applied there;
Samples, Runs, plan revisions, Metrology, Timeline and Project records were
authored through the actual API. Seed preparation completed 84 real requests.
The browser verified random sentinel templates, exact substrate hash, copied
source/config/isolation hashes and served route chunk bytes before writes.

Chromium 151.0.7922.173, Node 24.19.0 and Python 3.12.14 ran the finite
20-case matrix once, with one browser context at a time: **20/20 passed**.

| Cases | Actual qualification |
| --- | --- |
| Six Process starts | Preview and keyboard focus/Escape return, explicit confirmation, exactly one accepted start per fresh owner, real Run and plan graph readback. |
| Six in-place plan updates | Compatible v1 → v2 comparison, exactly one accepted confirmation per original owner, new plan revision and added Step readback without replacing the Run. |
| Six mixed surfaces | 720/721/1200 × actual light/dark; Samples, Sample, eight-column Processing, Metrology, Timeline, Project Map/Reading, real PNG decode, native Sample/Step href identity and legitimate local administrator denial. Every case asserts actual theme. |
| Two route chunk faults | One-shot 404/503 against the exact built Project chunk; navigation and product recovery stay visible, keyboard activates explicit Reload page, full URL survives, no automatic reload in the bounded 750 ms observation. |

Normal cases had no unexpected external origins or browser exceptions. Expected
local administration denial and injected chunk failures are separately recorded.
The browser uses actual responses; its accepted writes are retained. Read-only
final checks confirmed every original owner graph, Project revision 5 and exact
uploaded PNG bytes. These checks do not replay the twelve accepted operations.

## Additional pending and performance evidence

Two additional fresh-owner Metrology cases passed with real responses held after
the server had accepted them: create 201 → insert 201 → refresh 200, and direct
insert 201 → refresh 200. Close, Escape and backdrop remained blocked; competing
form/search/selection actions stayed unavailable; exact original insertion
payload, accepted entry identity and one-entry final readback were checked.
This is pending-flow evidence. Stale browser sessions remain separate from the
existing mounted ownership tests.

Chromium also confirmed a real accessibility defect: the picker search input's
computed accessible name is empty because its label span has `display:none`.
The first pending attempt passed its create case and failed the direct case's
named locator. The final fresh attempt used the exact placeholder and passed
both pending cases. It does not qualify the missing label. The next bounded
5F source change supplies an explicit name and needs new built-browser proof.

The separate actual Processing cost probe passed six phases on eight dedicated
API-created owners. Initial load issued eight detail GETs / 26,104 decoded bytes;
three local checkboxes issued no GET. A real individual Step correction issued
one PATCH 200, then eight GETs: seven owner response hashes were unchanged,
totalling 22,841 unnecessary decoded bytes. A real three-owner group confirmation
issued one POST 200, then eight GETs: five unchanged owners totalled 16,315 bytes.
Visible-column remove/add used seven/eight GETs. Final authoritative reads kept
plan identities, the correction note and exactly three Done/five Pending Steps.
Phase durations include form interactions and are not server latency budgets.
Two earlier locator attempts had no UI writes and remain failed receipts; all
seeded synthetic owners are retained. This measurement motivates a limited
owner-scoped refresh change, with full fallback for unknown scopes and explicit
overlap/failure/source-session safeguards.

## Diagnostics, shutdown and limits

The first startup's optional D1 `PRAGMA quick_check` returned `SQLITE_NOMEM`
before API/browser writes. That diagnostic remains failed. Independent physical
SQLite quick/FK checks and actual application health/readiness passed after the
corrected startup; no source change was made to hide that diagnostic.

The owned server terminated with SIGTERM/exit 143 before its asynchronous dispose
receipt completed. It is stopped: the owned PID is absent, port 4219 refuses
connections and no isolated-state descriptors remain open. After shutdown all
four D1/R2 SQLite files passed quick-check and zero-FK checks, and physical PNG
bytes matched the accepted upload hash. This is quiescent-state evidence, not
proof of graceful disposal; the reusable helper needs controlled disposal.

[Condensed receipts](PHASE_5F_INTEGRATED_BROWSER_RECEIPTS.json) retain actual case
IDs, counts, hashes, original failure identities and scope. Temporary raw receipts
and screenshots remain under the recorded private paths; they may not survive a
new cloud task. They contain synthetic research data, not production data.

Cloudflare Access still redirects anonymous curl requests to the development
site with 302. The development merge's Workers Build is separately observed;
its success cannot establish serving traffic, actual D1 migration state or
authenticated policy. Real providers, an isolated recovery target, independent
deployed job cadence, physical devices/IME, other engines, adjacent 1201/859/860
boundaries, Inspector and dirty/accepted-operation deployment handover remain
unqualified by this finite matrix. Local disabled authentication does not grant
system administration. Production `main` and live activation remain separate
from this owner-authorized development integration.
