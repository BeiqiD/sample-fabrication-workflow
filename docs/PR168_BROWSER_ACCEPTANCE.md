# PR #168 browser acceptance

Date: 2026-09-11. Tested in Chrome against the local application and its real local D1/R2 bindings. This extends the source and mounted tests with actual UI actions. No production data or deployment was changed.

## Defects found and fixed

1. **Bundled mathematics failed despite passing source tests.** Rolldown 1.1.5 corrupted isolated UTF-16 surrogate ranges in Temml's lexer. Both the Vite dependency optimizer and the production bundle parsed commands such as `\frac` as `\f`. The narrowly scoped `temmlBundlerCompat` transform leaves those ranges escaped until RegExp construction. Both Vite paths use it. The new `test:rich-text-bundle` gate executes real development/production bundles, checking fraction structure, two matrix rows, integrals, Greek letters, units, escaped currency, invalid formula fallback, and literal code. Removing the plugin reproduces the regression.
2. **Comment submission crashed in the HTTP browser preview.** Direct `crypto.randomUUID()` calls threw before submitting. The existing Project cryptographic fallback is now shared by all comment identities and canvas paste identities. A mounted regression verifies submission, finalization, refresh and clearing the composer when `randomUUID` is unavailable.
3. **The local full export returned a server error because the test database was stale.** Its migrations ended at 0030, while export queried `attachment_derivatives`, introduced in 0033. The database was backed up and existing migrations 0031–0035 applied locally. Export then completed asset generation. No application workaround or migration change was needed.

## Browser coverage

| Area | Actions and observations |
| --- | --- |
| Project creation | Created a dedicated project through the form; empty-title validation, autofocus and empty workspace checked. |
| Markdown | Added, edited, previewed, saved and reloaded a note containing inline/block math, fractions, matrix, integral, long equation, GFM table/tasks, escaped currency, literal code, raw HTML and malformed TeX. Correct MathML in Map, Inspector, Reading and editor Preview; only the deliberately malformed formula uses source fallback. Raw HTML remains text. |
| Cards | Selected a card, scrolled its body to the end without moving it, dragged its header, verified Undo restored its position, Redo reapplied it, then saved. Long reference titles wrap/truncate in their intended surfaces. |
| References | Searched REF-A, placed a result, observed automatic save, copied a stable link, used the occurrence/canvas menus to copy and paste, then reloaded and confirmed both occurrences persisted. |
| Project attachment | Uploaded a real 59-byte text file; checked completed metadata, edited a multiline caption, moved it to trash and confirmed it disappeared. |
| Sample comments | Submitted a long math note; verified its fraction and two-row matrix in sample detail and timeline. The compact timeline preview is 256px high with 781px of scrollable content; its 271px width does not overflow. |
| Sample controls | Opened Edit details, checked the normal-size Pinned checkbox and cancelled. Opened a note-delete confirmation without deleting existing records. |
| Processing | Switched status filters and checked the empty state. Opened the mobile process-plan comment dialog, submitted a math comment to the checked sample, reopened it and verified MathML. Escape closes the dialog. |
| Search | Found the newly submitted comment, excluded Comment from result types and obtained zero results, reset/applied filters, opened Reference details and followed Open source to the highlighted comment. Search summaries remain plain-text excerpts; the source renders the full comment. |
| Samples and timeline | Applied Lost status and obtained the empty state; cleared filters. Timeline Notes shows the saved math; Processing with no events shows the empty state. |
| Templates | Created a metrology template with a long title, opened and edited it, saved parameters, opened its deletion confirmation and cancelled with Escape. Opened the workbook importer and checked the narrow layout. |
| Responsive appearance | Inspected 1440px desktop, 1024px tablet and 390/360px phone layouts, including 600px height and light/dark themes. At 390px the reading column has no horizontal page overflow; a 509px equation scrolls within a 311px region with its left edge reachable. Task checkboxes remain about 14px. A long-title confirmation remains entirely usable at 360 × 600. |

Dedicated records: Project `project-1ec593d8-7040-44fd-9629-85918f306ecc`; metrology template `0841ebea-a0bc-4ad4-8b33-d607afce791a`; local REF-A math notes identify themselves with PR168.

## Validation and limits

- Full `npm test`: 846 source tests and 149 mounted tests passed, plus both bundled-renderer modes.
- Production TypeScript/Vite build and Project bundle budget checked after the fixes.
- This is Chrome coverage. Native mobile browsers and other browser engines were not tested.
- Project and full export reached their completion/generation states, but browser download events were not captured, including a top-level page attempt. File landing is **not verified**; generation feedback alone is not treated as proof of a downloaded archive.
- Workbook import was checked through the selection UI; a complete valid-workbook import was not performed. Managed-storage comment file uploads were not tested; the local managed-storage provider is not configured. Project-owned attachment upload was tested separately.
- Seed image records have metadata without matching bytes; their missing thumbnails are fixture limitations. No existing records were permanently deleted.
- Superseded by the subsequent interaction repair: Project Trash now restores items and their matching cascade connections, and deletion has Undo priority. Current implementation, browser evidence and limits are recorded in [PROJECT_UX_REPAIR_ACCEPTANCE.md](PROJECT_UX_REPAIR_ACCEPTANCE.md).
