# Source CI fixture cost qualification

This slice removes repeated SQLite fixture setup from the native S3 reader and independent File-job authorization tests. It changes no application, SQL migration, provider operation, authorization decision, test assertion or test deadline. Each case opens a fresh physical database and constructs fresh environment, policy, capability, credential and provider-object state.

## Source and preserved failures

The baseline is `7cdee5198188bcafc0b9e8703ac77451d0179234`, tree `c7bcea5d47ed70bb40aec56ed424e58ed6c4702a`. Both private copies came from `git archive`, without application state or build output, and shared only installed dependency files. Measurements ran sequentially in the explicitly quiescent development environment on Node `v24.19.0`; the finite focused runs used one worker and retained every existing deadline, including the default 5,000 ms case deadline.

The earlier failed runs remain evidence: PR252 post-merge run `38062074458` timed out in the V21 exact-rowid restore and four File-job authorization cases; the first local foundation gate timed out in the native reader case that constructs two fixtures; PR253 push run `38062827256` timed out in V21 restoration. PR253 run `38062853279` passed all source tests and later failed a separate mounted focus test. These distinct failures are not replaced by the focused passes below. This fixture slice does not claim to repair the V21 or mounted failures.

## Actual cost and equality checks

A finite native SQLite probe executed the original migration chains and exact authorization seeds. Its immutable receipt is `/tmp/source-ci-deadline-7cdee51-measurement-attempt2.json`. The first probe stopped on a Node SQLite null-prototype metadata assertion before qualifying anything; its failure log is retained separately. The corrected probe checked the numeric `foreign_keys` property and wrote a fresh receipt.

| Actual operation | Observed milliseconds |
| --- | ---: |
| Replay all 22 current migration files | 1,018.53 |
| Open fresh current-schema backup copies with foreign keys enabled | 1.78–2.06 |
| Original authorization per-case trigger removal, seed and restoration | 230.62 |
| Prepare the same authorization seed once in memory | 148.17 |
| Open independent prepared authorization copies | 1.58–1.78 |

The authorization fixture reinstalls 737 trigger definitions totaling 1,113,700 SQL bytes per original case. The 22 current migration inputs total 2,009,331 bytes. The probe compared the complete ordered `sqlite_schema`, every non-internal table, native cell storage types, hidden int64 rowids and primary-key ordering of `WITHOUT ROWID` tables. It checked foreign keys and all restored trigger definitions. Native `backup`, followed by a fresh physical copy, retained a witnessed hidden rowid of `9007199254740993` exactly. No `VACUUM` or table reconstruction is used for the new pristine images.

Each test file independently checks its prepared database against the real migrated image before running cases. The authorization fixture compares schema before and after its exact seed, so missing or changed trigger DDL fails setup. Added isolation cases mutate accepted jobs, allowlists, candidate revisions, credential availability and provider objects in one case database, then check fresh independent state and existing publication/provider behavior in another.

## Focused before and after

The immutable baseline run passed 42/42 cases across the native reader, authorization and untouched V21 protocol files. The candidate passed 44/44, including two added isolation cases.

| Timed case bodies | Baseline | Candidate |
| --- | ---: | ---: |
| Native reader, existing 21 cases; candidate additionally includes isolation | 26,599.73 ms | 2,505.72 ms |
| Native reader existing two-fixture revision race | 2,438.19 ms | 198.13 ms |
| Authorization, existing 10 cases; candidate additionally includes isolation | 2,474.99 ms | 530.24 ms |
| Existing simple authorization policy cases | 237–250 ms | 39–44 ms |
| Untouched V21 exact-rowid restoration control | 2,040.21 ms | 1,843.07 ms |

These are reported case-body spans, excluding file-level setup. The unchanged export control varied between runs; its variation is not an effect attributed to this patch. The baseline and candidate JSON reports are `/tmp/source-ci-deadline-7cdee51-{baseline,candidate}-focused-attempt1.json`. A narrow strict typecheck of both touched test files and the helper passed; it also exposed and corrected an existing zero-argument mock signature while preserving its primary-session assertion. The final run after that type-only correction passed 33/33 cases in the two touched files; its JSON report is `/tmp/source-ci-deadline-7cdee51-candidate-final-attempt1.json`.

Reproduce the focused behavior qualification with:

```sh
npx vitest run worker/storage/native-s3-byte-reader.test.ts worker/files/jobs/worker-runtime-authorization.test.ts worker/export-v21-protocol.test.ts --maxWorkers=1
```

## Limits

This is one finite, sequential before/after qualification on the development host with owned scratch SQLite files under `/tmp`. It demonstrates removal of measured repeated setup work, not guaranteed CI wall time or a repair of unrelated failures. Full source, native, mounted and remaining mandatory gates must still pass on the final integrated commit. Application recovery continues to replay and authenticate its own migrations and every provider/auth assertion remains active.
