# Backend reliability and stabilization acceptance

Status: Phase 6A1 recovery and scale baseline implemented; export and placement
repairs merged; the newly reproduced Sample split defect remains under repair.

Last updated: 2026-09-13

This is the continuing evidence record for the backend-first sequence in the
[product roadmap](./PRODUCT_ROADMAP.md) and
[stabilization plan](./V3_ARCHITECTURE_STABILIZATION_PLAN.md). Keep inventory,
reproduction, local verification, merged checks and deployed browser acceptance
distinct. An unchecked item is not completed by an earlier phase's tests.

## Baseline and scope

- Integration: `v2/backend-foundation`,
  [PR #186](https://github.com/BeiqiD/sample-fabrication-workflow/pull/186) merge
  `6a00f4ba650058cab4f5e5ae785324e9d8f50b1d`.
- Reviewed tree: `f27bfbdd13164644f22720e469052ffc5c80ce20`. The local review commit
  `5787b32e202ac3fa2c55eb0b2c90e3b910e54d70` has that same tree.
- Frontend regression reference: deployed behavior through PR #185. New visual
  refinement remains paused; a demonstrated persistence defect may require a
  focused client correction without starting the deferred controller rewrite.
- Synthetic local databases and provider fixtures are used for fault injection.
  No remote database reset, migration or provider cleanup is part of this record.

## Current evidence and open findings

| Boundary | Evidence | Current disposition |
| --- | --- | --- |
| Backend inventory | Source review of the exact tree above; route, SQL, shared-code and compatibility consumers counted below | Initial static inventory recorded; affected boundaries must be rechecked after extraction |
| Deployed complete-export download | Browser `/export` downloaded `sample-log-2026-09-13.zip`: schema version 7, 35 datasets (34 tables and the retention view), 95 rows, one blob, no warnings; packaged size and SHA-256 matched | Small baseline archive inspected; not a complete database/provider recovery rehearsal |
| B1: ZIP physical identity | Real FabuBlox import accepted distinct `foo bar` and `foo_bar` image IDs; sanitized archive paths collided and overwrote one payload. An accepted `../foo` locator was also normalized in the download URL and reported falsely missing | [PR #187](https://github.com/BeiqiD/sample-fabrication-workflow/pull/187) merged and deployed; browser download, hashes and row comparison passed |
| B2: placement save with unknown result | A real SQLite placement UPDATE was held while the client observed a network failure. The page allowed **Leave without saving**, navigation completed, then releasing the original UPDATE changed `x: 0 → 80` and revision `1 → 2` | [PR #188](https://github.com/BeiqiD/sample-fabrication-workflow/pull/188) merged and deployed; browser autosave, explicit Save and reload persistence passed |
| B3: split after actual execution images | A parent Sample with an image on its latest completed Step reads correctly, but split inserts a temporary `execution-assets:` identifier into the child's state foreign key. POST returns 500 and the transaction rolls back | Confirmed; repair the inherited state before publishing Sample extraction |
| Large-Project reads and saves | Actual Worker/local SQLite reads and mounted Page saves measured at 250/500 nodes; final response held to check acknowledgement ownership | Measured below; serial per-node HTTP remains a documented network-performance boundary |
| Full export-to-destination recovery | The new isolated verifier restored both browser archives: 34 tables, 94 canonical rows, one retention-view row and one blob with schema/FK/integrity/hash checks | Independent review and corruption/cleanup regressions passed; see the [recovery runbook](./EXPORT_RESTORE_REHEARSAL.md) for reproducible commands and limits |

B1's focused local repair probe packages the workbook, import manifest and three
images as five separate locators with matching hashes. The permanent regression
is `worker/export-archive-integrity.test.ts`, covering actual
import/export routes, archive contents and reconstruction of an independent
provider fixture. Byte reconstruction and JSON row comparison do not establish
database restore order, trigger behavior or recovery of the full lifecycle graph.

B2's fault injection uses the real placement service and migrated SQLite schema;
the lost response is simulated at the client boundary. The permanent regression
is `worker/project-placement-uncertain-settlement.test.ts`. Required
repair behavior is to retain the exact request and navigation protection until
acknowledgement or a relevant durable settlement proof. A rejected retry alone
does not settle an earlier unknown result. Group saves must wait for the final
acknowledgement, and an independent edge conflict must not discard an unresolved
placement save.

B1 merge: `6b050ac41438fb8eefb91abffca8688c0fc474ff`, reviewed head
`99c21112673e4ca9014cc134e756d6f4eebc89b1`, tree
`a3f4580ce02f906f8950452c2d4eed19bde17f3d`. All 11 local leaves and the latest
4 Verify / 14 commit statuses passed; source 994 and mounted 467 tests passed.
The first push attempt hit an existing navigation-test effect synchronization
race; the same-head PR run and targeted failed-job retry passed. A separate
characterization follow-up synchronizes the existing test with React effects
and asserts that the target navigation actually started.

Deployed B1 version `08976d51-ec70-440c-aff4-8c1ca8619673` loaded
`index-Dfb7EBqw.js`. Browser `/export` completed at Assets 1 / 1; its ZIP used the
new `blobs/r2/000001-…` path, contained the same 95 dataset rows as the baseline,
and had no warnings or byte-size/hash mismatch. Both downloads were then
recovered into separate local destinations with identical tables and bytes.

B2 reviewed head: `9ad4aa7815efefa9f5f2eebc17447a80870445d1`, combined tree
`0b38776b5d4ff8bdbc3affc2d874979955d2a5cb`. Four new uncertainty regressions and
existing save/Worker tests passed. Local leaf verification passed after clearing
stale generated build output and repeating a smoke whose assertions passed but
temporary-directory cleanup raced. Neither issue changes the required CI gate.
B2 merge: `885f31ef571ed6e7cb8720fa9c8cac01227e1eef`. Its first CI attempts passed
all 4 Verify checks and 14 commit contexts; the merge's complete 11-leaf gate
also passed, including source 998 and mounted 467 tests. Deployed version
`83afe174-5b39-4d5a-a1b7-429dd702c8e5` loaded `index-DlhhCDP3.js`. On the existing
synthetic QA Canvas Project, a card moved from x=-855.919 to x=-850.919, autosaved
and retained that coordinate after reload. Moving it back with explicit Save
again persisted after reload. The final geometry matched the starting point;
both reloads displayed Saved. Adversarial response loss remains covered by the
isolated real-SQLite tests, not by browser network injection.

The continuing fixture suite adds five scale cases and 15 restore cases. The
Worker smoke now uses bounded filesystem retries when removing its own disposed
temporary resources, addressing the observed ENOTEMPTY cleanup race while
leaving assertion failures visible.

### Deployment handover observation

Keeping the PR #187 document open while PR #188 deployed caused the subsequent
Projects navigation to request an obsolete lazy chunk and show the router's
application-error screen. Refreshing loaded the verified PR #188 entry and the
workflow passed. Preserve this as an open Phase 6B deployment-handover/browser
recovery case; refreshing for a version-specific check does not qualify stale-tab
recovery. The backend module-extraction gates do not close this frontend/release
boundary.

### Representative Project measurements

Synthetic, isolated fixtures exercised the real Worker and SQLite schema. The
save probes mounted `ProjectPage` and held the final response before observing
the transition from Saving to Saved. All saved placements increased revision
exactly once; already acknowledged writes were not retried by B2's fault tests.

| Fixture | Requests | SQL statements | Snapshot bytes |
| --- | ---: | ---: | ---: |
| 200 distinct external targets | 1 GET | 9 | 264,032 |
| 201 distinct external targets | 1 GET | 11 | 265,355 |
| 500 distinct external targets | 1 GET | 13 | 660,932 |
| 250 nodes / 400 edges | 1 GET | 7 | 427,545 |
| 500 nodes / 800 edges | 1 GET | 7 | 856,095 |
| Move all 250 nodes | 250 PATCH | 750 | — |
| Move all 500 nodes | 500 PATCH | 1,500 | — |

Save concurrency was one request. The measured time to the final response was
approximately 436 ms / 872 ms for 250 / 500 nodes in the same process with local
SQLite. These are diagnostic timings, not network latency, browser frame-rate
or memory guarantees. A bulk move still performs N serial HTTP requests; a bulk
API or queue optimization would need a separately reviewed atomicity/retry
contract. No data loss or premature Saved transition was observed in this probe.
The reusable fixture is `worker/backend-reliability-scale.test.ts`; its assertions
cover response identities, exact revision changes and final acknowledgement.
Query counts and elapsed time remain reported measurements, not fixed budgets.

## Worker and shared-code ownership inventory

`worker/index.ts` contains 6,392 lines, 56 direct HTTP routes, 280 `.prepare()`
calls and 32 `.batch()` calls at the baseline. The four additional route files
bring the total to 95 HTTP routes. These counts describe the starting point;
reducing a line count is not an acceptance gate.

| Root-owned slice | Routes | SQL prepare / batch calls |
| --- | ---: | ---: |
| Platform endpoints and shared helpers | 2 | 3 / 0 |
| Sample directory, detail, identity, lifecycle and records | 11 | 63 / 6 |
| Execution, plans, actual Steps, metrology and verification | 15 | 101 / 13 |
| Legacy Evidence commands | 5 | 37 / 5 |
| Asset upload and export delivery | 3 | 2 / 0 |
| FabuBlox import | 1 | 13 / 2 |
| Process and metrology templates | 19 | 61 / 6 |

Existing Comment submission, Project, Reference, blob lifecycle, ingestion and
storage modules remain the implementation base. The following concrete
ownership decisions guide the extraction:

- Sample structure reads are shared by Sample split and Execution start/plan
  operations. Give that query an explicit application owner; routers must not
  import each other or import back from `worker/index.ts`.
- Evidence owns legacy and canonical Comment commands and group-visibility
  policy. Readable common evidence and whole-group mutation have different
  visibility requirements; preserve both.
- Export owns the complete catalog and `/exports/all`, currently in
  `worker/project-foundation-routes.ts`. Preserve its one-D1-batch snapshot,
  all lifecycle states and blob-retention coverage when moving it out of Project.
- Project application services own replay and settlement queries, currently
  partly in `worker/project-routes.ts`. HTTP translates their result to status
  and mutation-disposition headers; a failed proof continues to mean uncertain.
- Scheduled maintenance coordinates import recovery, Evidence retry-window
  closure and physical blob GC in that order. Move Evidence timeout SQL out of
  `worker/blob-lifecycle/gc.ts` without weakening its atomic mutation guards.

The 15 production files in `shared/` contain no D1, React or provider
implementation. Separate them by actual ownership:

| Destination | Current surface |
| --- | --- |
| `shared/contracts` | Request/response DTOs and validators in `types`, `comment-submissions`, `project-api`, `project-types`, `project-copy-paste-api`, `reference-types`, `reference-search`, `reference-children`; stable Reference URL codecs/destinations |
| `shared/domain` | Content addressing, conservative Comment previews, Sample-record classification and attachment MIME/TIFF classification used by Web and Worker |
| Execution-owned algorithm | `plan-alignment` currently has only Worker consumers |

Template DTOs in `src/lib/api.ts` are the first consolidation candidate: constrain
Worker serializers with the same response contracts. Do not change accepted
inputs, output shapes or public retry semantics in a contract-movement PR.

## Compatibility and migration boundaries

`samples.process_revision` has no explicit runtime or test readers/writers; it
remains in the initial migration and model documentation. Full export selects
the entire Sample row, so its removal still changes the archive schema and needs
an explicit schema/compatibility slice.

`run_step_comments.body` remains authoritative for legacy occurrences without a
submission ID, and is duplicated for canonical submissions. Sample detail,
legacy timeline summaries, Reference resolution/search and export still read it;
legacy creation and canonical finalization still write it. The Execution grid
still chooses legacy Comment/image deletion when `submissionId` is absent.
Convert every applicable reader/writer and preserve legacy content, occurrence
IDs, group semantics and deletion provenance before dropping the column.

Use **Template** as the current public vocabulary; historical `recipe_*` database
names can remain. Splitting `events`, changing aggregate concurrency generally,
removing database triggers and adding a derivative producer remain separate
decisions, not automatic cleanup.

There are 37 active migration files, including two files numbered `0015`.
Existing schema/export coverage discovers tables from the migrated database and
classifies all views; reuse that gate. Trigger-owned history, lifecycle rollups,
identity/revision guards, publication, quarantine, retention and attachment
supersession must survive extraction and baseline comparison.

**The replacement baseline cannot be merged as an ordinary migration increment
to the deployed database.** Workers Builds currently runs the deployment gate,
applies unapplied files from `migrations/` to its bound database, then deploys.
The integration database already has an applied-migration ledger. Replacing the
chain with a full `0001_v3_baseline.sql` without handling that ledger would attempt
to create an existing schema.

Before baseline activation, classify each target as empty/disposable or retained
data, provide the applicable verified upgrade or isolated recovery/switch path,
and protect automatic deployment from applying the wrong migration set. Compare
the old chain plus approved cleanup against the new baseline, including tables,
columns, constraints, indexes, views and triggers. Run foreign-key/integrity,
representative transactions, host SQLite and local D1/workerd checks, then the
complete gate and affected recovery rehearsal. Retained-data verification must
include an existing-schema copy, not only two empty databases. Historical
migration fixtures may live outside the active Wrangler migration directory.

## Continuing acceptance checklist

- [x] 6A1: independent-destination recovery design/rehearsal and representative
  250/500-node read/save measurements implemented, with remaining limits recorded.
- [x] Repair B1 and B2 separately; record exact-head review, focused and complete
  verification, merged PRs and deployed browser regression evidence.
- [ ] Repair B3 in a separate correctness PR before Sample extraction, including
  ordered inherited images, concurrent state registration and transaction rollback.
- [ ] 6A2: extract Sample; Execution; legacy Evidence; process/metrology templates;
  import/assets/export; then review Project settlement, maintenance and the final
  composition root in independently reviewable slices.
- [ ] 6A3: consolidate Template DTOs, then finish contracts/domain ownership and
  enforce dependency direction without introducing a catch-all shared package.
- [ ] 6A4: review compatibility consumers, convert them, prove behavior, and only
  then apply separately reviewed schema cleanup.
- [ ] 6A5: qualify the clean baseline, archive/restore compatibility and each
  target's migration ledger/resource path before activation.
- [ ] 6A6: review the complete integrated head, permanent gates and browser
  behavior; record any explicit deferrals before declaring stabilization complete.

Each implementation PR starts from the latest integration head and remains
separate from unrelated code moves or schema changes. This record does not
complete outstanding C4 device/viewport acceptance or Phase 6B release rehearsal.
