# Architecture audit remediation

Audit reviewed: 2026-09-12. Status reconciled: 2026-09-13.

The audit baseline is PR #175 head
`352b3f7705051e6a664ab1a0e01a6d64cc140ad3`. Its complete tree was reviewed across
the Project and source-record frontend, Worker, Reference, storage, migrations,
export and delivery checks. The user then authorized the concrete repairs below.

## Completed repair scope

All three repair groups merged into `v2/backend-foundation` on 2026-09-12:

| Repair group | Merged PR | Merge commit |
| --- | --- | --- |
| Project consistency | [#176](https://github.com/BeiqiD/sample-fabrication-workflow/pull/176) | `ce834f9073e8421fb13ce21568546bea2849d4ba` |
| Source input/edit/upload recovery | [#177](https://github.com/BeiqiD/sample-fabrication-workflow/pull/177) | `83616c6bf96d8bc07e35460e67697b0bcf99e1d4` |
| Verification and architecture planning | [#178](https://github.com/BeiqiD/sample-fabrication-workflow/pull/178) | `791f00073ee69f4ce2c59a377705fe3faee61423` |

They build on the Inspector/shortcut baseline without changing its visual scope
or requiring a schema/provider migration. Current integration is PR #185 merge
`c4bf698e3753a0474e7d75d400af6685ff874a6a`; deployed desktop evidence and remaining
wide-screen, physical-device and large-Project checks are in the
[current C4 record](./PROJECT_C4_ACCEPTANCE.md#current-integration-check--2026-09-13).
Phase 5C4 remains in progress; Phase 5D has not started. The larger Phase 6A
ownership changes below remain scheduled after Phase 5F.

| Finding | Repair boundary | Required regression evidence |
|---|---|---|
| F1: a Project can accept a 201st distinct reference target, then fail snapshot reads | Batch resolution inside the Project aggregate while retaining the public resolver's 200-target limit | Real migrated database and Worker reads at 200/201/500 distinct targets, duplicate/mixed types and deleted-history snapshots |
| F3: single-card removal loses an earlier uncertain request after a rejected retry | Retain the exact request and navigation protection until acknowledgement or a relevant durable revision fence proves settlement | Lost response followed by 403; 409 with and without sufficient revision advance; preserve existing bulk-trash behavior |
| F6: layout saving disables keyboard history more broadly than toolbar history | Share command availability across toolbar, keyboard and execution guards | Geometry and edge undo/redo agree across inputs while respecting independent revisions |
| F2: a reused metrology page can show one entity's draft while submitting to another | Bind the entire edit session to template ID and ignore stale loads/mutation completions | Route A to B has B fields and B submit target; delayed A cannot affect B; same-ID focus navigation preserves drafts |
| F4: a transient storage-status failure is cached for the browser session | Retry failed capability queries while coalescing concurrent requests | Failure then recovery works in the existing/new Composer; concurrent queries deduplicate; uploads retain their protocol |
| F5: malformed Sample bodies become server errors | Parse unknown JSON and validate Sample request shapes before database work | Malformed JSON, null, primitive, array and wrong field types return 400; valid legacy input semantics remain |
| A4: export tests cannot independently discover omitted future tables | Compare the export catalog against the schema produced by actual migrations | New omitted business tables, including underscore-prefixed names, fail; internal views have explicit reconstruction decisions |
| A6: CI repeats checks and deployment omits the export type contract | One shared leaf-check inventory for CI/deployment, retaining local domain commands | Source/mounted suites, export types, migration, each required Worker smoke and build are covered without repeated main-job execution |
| A6: success/failure publish different commit-status contexts | Keep context identities fixed and describe pending, failure and unexecuted stages truthfully | Success to failure to success updates the same context |
| A7: bundle checks inspect only entry text or a separate source build | Inspect the initial static chunk graph and exercise the actual production artifact | Indirect eager Map imports fail; built Worker/API and SPA assets pass integration checks |

The template issue requires a route-identity change in the same mounted page;
returning to the template list normally unmounts it. The original probe observed
a client call with the wrong draft, not a write to a real database. The existing
name uniqueness constraint can reject an unchanged old name, but cannot bind
the remaining fields to the correct edit session.

For F3, a 403 for a retry proves only that retry was rejected. It does not settle
an earlier request whose response was lost. A snapshot with unchanged relevant
revisions cannot release that original request merely because it looks active.

## Architecture work retained for Phase 6A

The repairs establish a safer behavior baseline; larger ownership changes remain
in the existing [stabilization sequence](./V3_ARCHITECTURE_STABILIZATION_PLAN.md)
after Phase 5F:

- converge ordinary single/bulk Project lifecycle execution, then narrow the
  snapshot/working-geometry/acknowledgement write boundary;
- keep Comment visibility and lifecycle policy in Evidence, Project settlement
  proof in application operations, full-system export in Export, and scheduled
  maintenance outside physical blob GC;
- extract reusable media presentation from the Execution grid and move concrete
  Web/Worker DTO contracts with typed serializers;
- replace implementation-string tests only where an extraction needs behavior
  characterization; retain D1 guards, trigger invariants and exact retry tests;
- classify each baseline target as disposable or retained-data, then verify its
  rebuild/recovery or upgrade path in addition to empty-schema equivalence;
- qualify an export/restore round trip and browser memory budget, and measure a
  large Project through the end of a multi-card save before changing write
  concurrency.

The audit found all 34 business tables at its baseline represented in complete export;
the new coverage gate protects future changes rather than repairing known data
omission. The current single Worker, normalized Project model, stable source and
occurrence identities, atomic D1 batches and shared blob-retention rules remain
the architecture baseline.

## Historical verification record — integrated #176–#178 repair workspace

The integrated repair workspace passed:

- complete source suite: 183 files, 992 tests;
- complete mounted suite: 57 files, 414 tests; the seven template-identity tests
  also passed after correcting their role-query type options;
- ten verification-script tests, including context transitions, failure
  propagation, profile parity and indirect eager Map imports;
- development/production rich-text rendering, export type checks and ordered
  local D1 migration verification;
- Reference and Reference-search workerd/D1 smokes;
- TypeScript and Vite production build;
- static bundle ownership: five initial chunks and fifteen Map chunks;
- the actual Vite Worker and assets in workerd, including API health, SPA fallback,
  JavaScript delivery, unauthenticated Access rejection, existing mutation/media
  checks, and successful reading of 201 distinct reference targets.

The common profile was completed in stages after the test type correction;
checks already passed were retained, then the affected test and build/artifact
checks were rerun. Each published repair head then had its independent CI gate;
the merged repair and later deployment evidence is retained in C4.
Passing jsdom or local workerd checks does not establish remote
deployment, device usability, disaster recovery or measured browser frame rate.
The PR descriptions record the exact head, executed commands and results for
each repair group.
