# Workbook import browser acceptance

Use this checklist for changes to workbook compatibility or import execution.
Keep the existing multipart submission, request identity, version relationship,
and workflow update protocol. Compatibility belongs in the format registry and
parser; users do not have to convert workbooks before importing.

## Test environment

Run against an isolated installation with real application routes, D1 and R2.
Use both legacy storage and active File authority. A successful first import in
legacy mode does not qualify a repeat import in active mode.

Use a private representative workbook supplied separately, plus generated classic
and capability-flow fixtures. Never commit a user's workbook, authentication
material, or captured private workbook content. Supply fixture paths explicitly.
Use signed application sessions. Record the source commit, build identity,
storage mode, browser version, viewport, screenshots, HTTP results and failures.

Probe the deployed development URL separately. If authentication prevents access,
record that limit; isolated browser results do not establish deployed acceptance.

## Required browser journeys

Business actions in this table must be performed with browser controls. Read-only
API inspection may independently verify persisted identities and data. API
seeding is a prerequisite, not evidence that the corresponding UI action works.

| Journey | Required observations |
| --- | --- |
| Choose and preview | Real file chooser; expected sheet, ordered steps, groups and diagrams; parameters and notes retained; no POST before confirmation. Substrate and provenance stay secondary. |
| Invalid file and reselection | Invalid XLSX reports a local error without POST; selecting a valid file recovers. Changing a preview does not submit it. |
| First import | Confirm once and rapidly twice; exactly one POST and one new version; success opens the returned template; images load from persisted storage. |
| Leave after success | Navigate away, return and reload; no stale success notice or recovery checkpoint; another import can be started. |
| Next version | Select the existing family with Version relationship and import identical content again; new request returns a new immutable version; existing typed image bindings remain valid. Run in both storage modes. |
| Create and execute | Create a Sample, choose the imported process, inspect the structure preview and start a run. Record actual values, complete a step, add a Comment and image evidence, then reload. Verify saved values and step identity. |
| Update a running plan | Import the newer layout into the same family, preview and confirm the future-plan update. Recorded step IDs, status, actuals, Comments and evidence survive; future additions and changes appear in order. Reload and continue the next step. |
| Complete a small process | Use a generated classic/capability pair to exercise the complete run lifecycle without manually finishing every step of a large private recipe. |
| Leave during submission | Navigate away and reload during a real accepted POST. Restore the same request identity, check status and open its actual result without a second POST. |
| Lost response | Explicitly drop response delivery after the real backend processes the request. Status recovery must find the existing result and avoid another version. |
| Pending and failure | Delay real execution separately from response delivery. A pending receipt must not be described as success; a terminal failure must allow an explicit new attempt. Unknown outcomes retain their identity. |
| Responsive interaction | Repeat representative upload/recovery/processing controls at desktop, tablet and touch-phone widths, in light and dark themes; check focus, clipping, target spacing and actionable errors. |

## Fault boundaries

Label any transport delay, aborted delivery or artificial operation budget as
fault injection. Do not replace a backend response with a fabricated ready or
pending DTO and call that an end-to-end import test. A delayed response after a
commit proves response recovery, not recovery of a killed executor.

The status endpoint reports the persisted receipt; it does not resume a stopped
executor. An interrupted pending import can remain pending until its existing
24-hour lease expires and scheduled maintenance runs. Do not discard its browser
checkpoint or create a replacement request merely to make the UI appear unstuck.

Retain original failed runs and distinguish application defects from harness
selector/timing mistakes. Record unexecuted journeys explicitly. Passing the
matrix establishes the tested journeys, not every possible deployed failure.
