# Exact SQL canonical string cache qualification

This slice reuses only the pure lexical JSON representation of an exact raw SQLite DDL string. The cache stores immutable strings, with 2,048 entries and 8 MiB of accounted UTF-16 key/result bytes as independent limits. Public `canonicalFileAuthoritySchemaSql` and `fileShadowSchemaSlice` keep their existing fresh mutable-array behavior. The fingerprint input keeps the previous nested tuple JSON encoding byte for byte.

No schema identity, database row, manifest, profile revision or validator result is memoized. All four V21 validation boundaries, independent snapshots, hashes, rowid/provenance checks, provider assertions and actual restoration migration execution remain. Unknown or changed SQL takes its own derivation path; parsing errors are not cached. Oversized strings bypass retention, limits are captured and validated, and least recently used entries are evicted within both bounds. The byte budget accounts for retained strings, not total process heap or engine allocation overhead.

## Baseline and actual bottleneck

Private qualification used immutable source `7cdee5198188bcafc0b9e8703ac77451d0179234`, tree `c7bcea5d47ed70bb40aec56ed424e58ed6c4702a`, Node `v24.19.0`. No application state was copied and no remote database/provider was contacted. Runners were sequential within an explicitly quiescent development test window, with one worker and existing default deadlines unchanged.

The original V21 exact-rowid restoration diagnostic passed in 2,083.74 ms. It executed four full validators and 14 actual content migration executions. Migration construction consumed 1,065.24 ms; canonical tokenization consumed 153.08 ms across 5,243 calls. Column parsing consumed another 26.43 ms. Lexical work was measurable but secondary to migration execution; this patch does not claim to repair all historical CI timeouts. Original failed source CI receipts remain preserved separately.

The original trace is `/tmp/export-v21-deadline-trace-7cdee51-attempt1.json`. Node-only diagnostic imports and tracing are private instrumentation and are absent from the shipped shared code.

## Finite cost measurement and rejected first bound

The cost probe rebuilt actual V21 and current V24 native SQLite schemas and performed a fresh `sqlite_schema` query before every timed fingerprint. Every one of its 40 timed results matched the reviewed generation pin. SQL replay, module builds and query durations were outside the fingerprint timers. The first V21 candidate group started with an empty cache; V24 retained earlier V21 strings, as the cache permits only exact immutable input reuse.

An initial 1,024-entry candidate was rejected after measurement: V24 has 1,050 distinct raw SQL inputs, so its first five fingerprints regressed from 259.45 to 318.88 ms. That receipt remains `/tmp/export-canonical-cache-7cdee51-measurement-attempt1.json`. V21 has 987 distinct inputs. Their complete key/result string accounting is 6,927,494 bytes for V21 and 7,385,848 bytes for V24, each within the unchanged 8 MiB byte budget. The final entry cap is 2,048.

The final actual cost receipt is `/tmp/export-canonical-cache-7cdee51-measurement-attempt2.json`:

| Five fresh schema reads and fingerprints | Baseline | Final cache |
| --- | ---: | ---: |
| V21, first group | 302.16 ms | 155.02 ms |
| V21, repeated group | 254.29 ms | 73.90 ms |
| V24, first group after V21 | 268.32 ms | 69.58 ms |
| V24, repeated group | 249.08 ms | 66.64 ms |

These are finite fingerprint-operation measurements on one host, not guaranteed end-to-end or CI wall times. Future larger schemas may reach either limit and correctly recompute evicted or oversized inputs.

## Behavior and independent diagnostic

All 20 new cases passed: six cache bounds/key/error cases, three fingerprint mutation/encoding cases and 11 actual V14–V24 migration checkpoint cases. The latter replay the actual migration chain once, capture each native schema and check foreign keys, then compare each reviewed pin and the previous encoding under the default case deadline. Empty inventories, null SQL, quoted bytes, fresh reversed objects, modified SQL on the same objects and externally mutated public token arrays are covered. Shared production and the new test scope passed strict type checks; independent read-only review found no blocker.

A separate constant-key cache negative control failed exactly when a changed SQL body incorrectly retained its old fingerprint. Restoring the safe helper passed that same case. The reports are `/tmp/export-canonical-cache-negative-7cdee51-{red,restored-green}-attempt1.json`; the full 20-case report is `/tmp/export-canonical-cache-7cdee51-focused-attempt1.json`.

The final V21 diagnostic passed the unchanged exact-rowid/provider assertions and default 5,000 ms case deadline. All four full validators and 14 migration execution phases remain, with no unfinished phase. Canonical parser calls fell from 5,243 to 1,295 and measured parser time from 153.08 to 40.68 ms. Column parsing remained 452 calls; migration construction measured 1,048.63 ms. The whole case measured 1,930.58 ms compared with the earlier 2,083.74 ms diagnostic, one finite pair rather than a general timing guarantee.

The final trace is `/tmp/export-v21-deadline-trace-7cdee51-attempt2.json`. The first candidate diagnostic passed its case but failed receipt publication after the case because its proposed basename violated the diagnostic helper's fixed path fence. That failure log remains `/tmp/export-canonical-cache-v21-instrumentation-attempt1.log`; the accepted distinct path did not overwrite the baseline. No product assertion or deadline was changed to obtain the final receipt.

Reproduce behavior qualification with:

```sh
npx vitest run shared/domain/bounded-string-memo.test.ts shared/contracts/export-schema-canonical-cache.test.ts --maxWorkers=1
```

Final integrated mandatory gates and exact-head CI remain required. Application restoration continues to execute and authenticate its actual migrations; no transaction or PRAGMA shortcut is part of this patch.
