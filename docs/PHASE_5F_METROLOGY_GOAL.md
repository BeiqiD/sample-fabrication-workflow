# Queued goal: 5F-2d Metrology drawer pending work and session ownership

Status: **bounded local goal complete on 2026-10-10**. See the
[acceptance and limits](PHASE_5F_METROLOGY_ACCEPTANCE.md) and
[check receipts](PHASE_5F_METROLOGY_RECEIPTS.json). Combined-tree CI and integration
remain subsequent gates; this does not complete all Phase 5F coverage.

Source baseline: `3c1baf5fdb21994c0510754eb20919db8189a91a` on `codex/fp2-fp3-development`.
The preceding saved-job control ACK slice has focused, full mounted and build passes, recorded in [the initial acceptance](PHASE_5F_INITIAL_ACCEPTANCE.md). Its CI qualification is separate from this queued goal. This goal does not mark all of Phase 5F complete.

## Goal

Keep the Add metrology drawer responsible for the full Save and add operation, from template creation through entry insertion and the existing `onSaved` callback. Once the original drawer session is gone, it must not initiate a follow-up insertion, refresh the abandoned view, close a later drawer, or update a later session's pending/error state.

Preserve the normal creation and insertion payloads, the insertion point, direct Add of an existing template, current error presentation, the shared modal hook and the ordinary Processing refresh contract.

## Concrete defect

Open an editable Processing run, choose **Add after this entry → Metrology → Create new metrology template**, fill the form and press **Save and add**. Hold the template-create response.

The embedded form disables its own controls, but the outer drawer's busy condition only checks `savingId`, which is still empty. Escape, Close and backdrop can dismiss the drawer. When creation later resolves, `createAndAdd` still calls `add(created.id)`, issuing another POST against the original sample/run. The same continuation can occur after a source navigation or keyed grid unmount.

Evidence:

- `src/components/MultiSampleRunGrid.tsx:609`: shared modal hook blocked only by savingId.
- `src/components/MultiSampleRunGrid.tsx:629`: add sets savingId only when entry insertion starts.
- `src/components/MultiSampleRunGrid.tsx:643`: creation is awaited before entering add.
- `src/components/MultiSampleRunGrid.tsx:648` and `:650`: backdrop and Close use the same incomplete condition.
- `src/components/MultiSampleRunGrid.tsx:1368`: drawer lifetime follows its mount/open session.
- `src/components/MetrologyTemplateForm.tsx:42`: the form's private saving state does not reach the outer drawer.

These are source-confirmed paths. A new actual-grid mounted reproduction is required before implementing the change; no new runtime reproduction was performed while preparing this goal.

## Authorized implementation boundary

Primary source: the private MetrologyPickerDrawer in `src/components/MultiSampleRunGrid.tsx`.
Verification: one dedicated `src/phase5f-metrology-pending.mount.test.tsx` suite using the real grid, plus a narrow update to the existing drawer source assertion in `src/grid-modal-behavior.test.ts` if its literal condition becomes obsolete.

No shared hook, host page, backend, API, request protocol, persistence, idempotency, migration or provider change is needed. Do not introduce a test-only export or broader component refactor solely to make the drawer easier to mount. MetrologyTemplateForm should retain its current local draft/error contract; change its interface only if the parent pending boundary demonstrably cannot be expressed within the drawer.

Implementation decisions:

1. The outer drawer owns pending work from immediately before create dispatch until create → add → `onSaved` settles. Direct Add remains pending through insertion and `onSaved`. One busy predicate governs Escape, Close, backdrop and competing actions.
2. Represent the create phase explicitly. Do not reserve an arbitrary template-id string as a busy sentinel.
3. Capture the original drawer/session and its sample id, run id and insertion point. Fence continuation before the second POST and before subsequent refresh/close/state callbacks. An unmount/remount with the same business identifiers is a new session.
4. Guard success, failure and finally effects. An old result must not close or unlock a later session. Keep the hook unconditional and use its existing blocked behavior.
5. Do not bind this owner to a refreshed run object or updatedAt: an ordinary successful `onSaved` read should not invalidate the operation that requested it. Preserve the host's existing keyed grid boundary for actual source/run changes.
6. Preserve controlled error handling for direct Add. If a helper is extracted, its rejection must not escape the existing `void add(...)` event path unhandled.

Normal payloads remain:

```text
createMetrologyTemplate({ name, toolName, parametersText, commentsText })
  -> { id, version }
createMetrologyRunEntry(sampleId, runId, {
  templateVersionId: created.id,
  afterStepId: originalInsertionPoint
})
  -> { id }
await onSaved()
close the current drawer
```

For an existing template, only the insertion call is dispatched, using that template id and the same original target/insertion point.

## Accepted writes and existing limitations

- A dispatched create or add request may complete after navigation. UI dismissal is not cancellation or rollback. If creation has already been accepted before owner invalidation, its template can remain saved even though this session never sends the second POST.
- These APIs do not expose the retained request identity or receipt reconciliation used by research packages. This slice does not promise no duplicate acceptance after an unknown ACK, and must not add automatic POST retry, deletion or cleanup.
- Existing `add` catches its failure and resolves. After a successful create followed by failed add, the embedded form keeps its draft and can later attempt creation again. The existing template name/type/version uniqueness constraint may reject that attempt with 409. Defining reuse/recovery of the accepted template is a separate follow-up, not an exit requirement for this pending/session fix.
- Processing passes `onSaved={load}` with `propagateError=false`. An accepted write followed by a GET failure shows the page read error while the callback resolves and the drawer closes. Preserve that ordinary refresh behavior; do not replace it with strict attachment refresh or reinterpret it as a failed write.
- A mounted test may explicitly reject an `onSaved` stub to qualify callback cleanup. That case must not be presented as the ordinary Processing host's default GET-error behavior.

## Meaningful mounted verification

Render the actual MultiSampleRunGrid. Start from the typed active process run/sample shape in `src/attachment-media.mount.test.tsx:219`, with one fabrication step and empty comments/images/attachments where possible. Retain the real StepCell menu, real embedded form and real shared modal hook. Stub matchMedia, ResizeObserver and managed-storage metadata as existing grid tests do.

Mock only the specific API methods needed for this fixture: listMetrologyTemplates, createMetrologyTemplate and createMetrologyRunEntry. Use typed successful receipts, deferred promises and a deferred `onSaved` callback. Install a global fetch stub that rejects any unexpected request; no real worker, server, storage provider or DB may be contacted.

Required cases:

1. Reproduce the current missing busy boundary with three separate user dismissal paths while create is pending: Escape, Close and backdrop. After the fix the drawer and submitted draft remain present, and creation is dispatched only once for that one submission.
2. Force the host/keyed grid to unmount while create is pending, then resolve creation. No entry insertion, old refresh or old close callback follows. Do not assert that the already accepted template was rolled back.
3. Remount/open the same business target as a new session while the prior create or add response is held. Resolve/reject the old result; the new session stays open and retains its own pending/error state. Use host removal/remount for this case because ordinary dismissal is intentionally blocked while pending.
4. Normal create → add → `onSaved`: assert the exact original form payload, exact sample/run/template/afterStep payload, ordered calls, one call per phase for that single successful submission, and closure only after `onSaved` settles.
5. Hold entry insertion and then `onSaved` separately. The three outer dismissal paths and duplicate/competing actions remain blocked throughout both phases. A finally from an invalidated operation must not release a new session's busy state.
6. Direct Add of an existing template: no create call; exact insertion payload once; pending through `onSaved`; current-session close afterward. Retain the current controlled error path.
7. Current create failure retains draft and releases outer/form pending without inserting or automatically retrying. Current add failure releases pending with the existing visible error and no automatic additional POST. Do not conceal the accepted-template recovery limitation.
8. Existing idle Close/Escape/backdrop still dismiss appropriately; clicks inside the drawer do not dismiss it. Search focus, embedded title autofocus and modal Tab trapping remain available. Completed/read-only runs continue to hide or disable the relevant Add actions.

Use controlled promise settlement rather than sleeps or fake polling loops. Where idle template listing uses its existing debounce, preserve that timing rather than replacing the API call with a fabricated immediate result.

Existing regressions to retain:

- `src/grid-modal-behavior.test.ts`: shared modal use and dismissal contracts.
- `src/phase5e-advanced-records.mount.test.tsx`: form pending and draft retention.
- `src/attachment-media.mount.test.tsx`: actual grid, Dense attachment adapters and read-only behavior.
- Processing preview/confirm suites: accepted plan/start identity and refresh behavior. Those suites mock the grid and therefore do not replace the new actual-grid tests.
- Grid geometry, comments, attachment density and mutation payloads remain outside this source change.

## Finite exit

- Retain the actual pre-fix mounted failure evidence for the demonstrated pending/session defect.
- Full-chain busy and original-session fences pass the required real-grid mounted cases.
- Current failures release pending appropriately without introducing replay; stale outcomes have no follow-up write or UI callbacks.
- Direct Add and normal create/add payloads, existing modal behavior, ordinary refresh semantics and relevant read-only/draft regressions pass.
- Complete focused checks, full mounted qualification and build on the applied source; record any necessary browser checks against that source.
- Accepted-write and error-recovery limitations above remain explicit in the handoff/roadmap record.

Only then mark this queued slice complete. Standalone Metrology navigation ownership, picker search-result ownership, broader focus return, mixed-domain browser/theme/responsive qualification and physical input acceptance remain separate Phase 5F coverage until independently measured.
