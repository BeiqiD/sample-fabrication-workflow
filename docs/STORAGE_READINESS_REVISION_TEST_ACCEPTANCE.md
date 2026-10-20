# Candidate revision evidence test synchronization

At foundation head `4bf8e71`, push Verify 38072220327 passed all 15 leaves (355 native, 3502 source and 980 mounted tests). Its independent PR Verify 38072223733 failed one of 980 mounted tests: the newly saved candidate revision was visible before its automatic test-history read settled. That read deliberately invalidates any concurrent evidence observation. The final DOM had historical revision 2 and an empty evidence panel, rather than stale positive evidence.

The test now holds the revision-triggered history response, observes the blocked panel and disabled refresh button, confirms any earlier revision-3 observation was aborted, and then settles history before requesting one explicit fresh revision-3 observation. The final negative-evidence and exact expectedRevision=3 URL assertions remain. Each pending transport receives its own Response. Production behavior, timeout budgets and automatic retry policy are unchanged.

Actual isolated qualification passed 15 readiness cases, all 89 cases across the six affected storage mounted files, and strict client types. Removing history-load evidence invalidation alone makes the controlled case fail at the required blocked-state assertion; the original production bytes were restored. An independent source review found no further issue. The first two controlled-fixture failures and original remote failure remain in the linked receipt.

See [actual receipts](STORAGE_READINESS_REVISION_TEST_RECEIPTS.json). These focused checks do not establish a new complete local 15-leaf run. New exact-head push/PR complete checks are required before ordinary development merge. RT1–RT6 and group authorization remain unfinished.
