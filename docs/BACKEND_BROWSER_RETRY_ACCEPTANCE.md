# Backend browser acceptance after connection recovery

Date: 2026-09-13. This closes the interrupted current-schema browser checks
described in [backend reliability acceptance](./BACKEND_RELIABILITY_ACCEPTANCE.md).
It does not accept an S1/S2 deployment or complete Phase 6A6.

## Version and scope

The existing integration site served the S0 application at integration
`8f5d5212915d0d8ed7002baf3c2c35691b609a8d` after PR #201. Its Workers Build and
both integration Verify jobs succeeded. The browser entry was
`index-BepHkGtU.js`, matching the locally verified application build. Browser
steps used the existing synthetic QA fixtures; no research record was edited.

The following backend preparation was then reviewed and merged separately:
[PR #203](https://github.com/BeiqiD/sample-fabrication-workflow/pull/203),
head `72d9bde27a5b7379365d646309a9884327287f42`, merge
`8930c04996358657d36883e99f11482f74cad7a4`. Its source tree matched the local
review. All 11 local verification leaves passed: 84 verification-script tests,
194 source files / 1105 tests, 62 mounted files / 467 tests, and all required
type, migration, Worker and production-artifact checks. All four remote Verify
checks and 14 commit contexts passed, with no outstanding review threads.
This PR adds an explicitly invoked read-only D1 observer; it changes no runtime
route, schema, provider binding or deployment command. It has not been invoked
against a live database.

## Browser results

| Flow | Observed result |
| --- | --- |
| Process-template import | Existing synthetic `QA-backend-split.xlsx` preview detected Step 0 and one executable step. Confirmation saved `QA backend split v1`; the template directory and process chooser both returned it. |
| Execution image and completion | Started the first process on `QA-BACKEND-SPLIT-20260913`, uploaded the synthetic image through **Correct execution**, and saved status `done`. The run completed; Sample **Current structure** showed the actual execution image. |
| B3 Sample split | Confirmed two children. The parent became consumed, both child links appeared, and both children displayed the inherited structure. Parent and both children used the same loaded asset (256 × 128). The first child's image and identity persisted after reload. No 500 or partial split appeared. |
| Inherited structure handoff | Starting the second child's first process showed the inherited execution image as the previous structure before confirmation. |
| Sample note | A synthetic note saved on the second child and appeared in Notes and the timeline. |
| Canonical process Comment | Added a text Comment to the second child's pending step. The text and author/time read back correctly. The deletion confirmation contained the same text; Cancel preserved it, and reload retained it. No deletion was confirmed. |
| Reference search and source focus | Searching the exact canonical Comment phrase returned one result with the correct Sample, Run and Step. **Open** navigated to those IDs and the Comment focus token. The target Comment and step were highlighted; the screenshot showed readable text and date. No Project card was added or moved. |
| Full v8 browser ZIP | Export completed with four of four assets. Both required provenance files, all declared table files and unique ordinal blob paths were present; isolated restore validated hashes, rows, schema, foreign keys and integrity. The final archive included the canonical occurrence and its owning submission. |

Synthetic fixture identities retained for follow-up:

| Object | ID |
| --- | --- |
| Parent Sample | `f48e3a76-4573-40c3-8f1e-c63c09bda16a` |
| First child | `78265820-ffae-43a2-9e58-3cb02ec9663d` |
| Second child | `99e68500-9bd9-48f2-8936-4406e8e48d96` |
| Imported template | `5f6ffedb-ea80-4d12-a8fb-aab12cafdf3b` |
| Parent completed Run | `8e45a456-1ed0-4a59-95d7-91c9308db379` |
| Second child's active Run | `7147aabe-749e-4024-95ba-1b16eec99bd0` |
| Canonical submission / occurrence | `6fe67d5c-74f9-4529-9eb1-48c9d3a8db52` / `ab45237c-0698-4434-b05f-7005e72dffd3` |

## Download and independent recovery evidence

The browser's download-event waiter timed out despite completed file downloads.
The actual newly synchronized ZIP files were located and inspected before any
additional export; this was not treated as an application export failure. A
second export was deliberately made after adding the canonical Comment.

| Archive | SHA-256 | S0 restoration |
| --- | --- | --- |
| After split and Sample note | `61a9f731c24449d5b6fd884c97243787bf756dfa458ad70d8bf58abf8e2968c6` | 34 tables, 125 rows, 4 blobs |
| After canonical Comment and source-focus check | `8ec3202d36fdece04d61a489db61fab9cca1da99d0903a9c4eb3e90ba7110fe2` | 34 tables, 135 rows, 4 blobs |

Both archives restored into distinct new local destinations with zero warnings,
198 triggers reinstalled, exact row/schema equality, foreign-key/integrity
success and valid Project relations. Original ZIPs and source-schema/retired-field
provenance were retained by the verifier. The final logical occurrence has
`legacy_body: null`; its text is in the owning submission. Retired-field metadata
preserves the actual S0 compatibility values separately. No missing field was
filled by a default.

## Remaining boundaries

These results qualify the exercised current S0 workflows, not an exhaustive
device matrix. Legacy-only Comment creation, destructive deletion/restore,
common-scope overlap, network-response loss and concurrency faults retain their
separate permanent local tests; they were not injected in this browser run.
The previous stale-tab/lazy-chunk deployment handover issue remains open in
Phase 6B. A successful reload here does not close that issue.

Drafts #199/#200/#202 remain inactive. Live schema/ledger observation, historical
request retirement or a separately qualified recovery/cutover path, remote
execution, final S2 browser acceptance and the integrated 6A6 exit are still open.
Current browser success and the read-only observer do not satisfy those gates.
