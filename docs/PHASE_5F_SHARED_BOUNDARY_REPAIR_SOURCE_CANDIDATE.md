# Project creation witness canonical shared ownership

Date: 2026-10-10 UTC. Status: source-only repair; affected local runners and the
replacement head's complete Verify/Map are **UNRUN** at this checkpoint.

PR #259's own-head Verify runs at `d7d2a88ff354dccea7520e8e7e0c12f0cd3475fe`
failed the existing shared-boundary assertion. In each run the preceding native
suite passed **356/356**, the `verification-scripts` leaf failed, and all **14**
downstream leaves were skipped. They are unrun, not passing or failing tests.
The first fatal assertion was:

```text
shared/project-creation-subject.ts: code outside canonical directories must be a compatibility re-export
```

The shared ownership rule permits implementation in `shared/contracts` or
`shared/domain`; a root compatibility path must contain a sole `export *`.
The source repair moves the original witness implementation byte-for-byte into
`shared/contracts/project-creation-subject.ts` and changes its old path to:

```ts
export * from "./contracts/project-creation-subject";
```

The six existing importing consumers keep their exact bytes. Header names,
validation, hashing purpose/version/authentication family/installation/actor,
and exported function ownership remain the same. The boundary verifier,
whitelists, test assertions, deadlines and compiler options are unchanged.
There is no SQL, authorization, accepted-input or write-behavior change.

| Exact source identity | SHA256 |
| --- | --- |
| Original implementation and new canonical implementation | `df307cc57aeb5706dd770220cdc7f4b47d99a33a6d8c8232e30f693878827f27` |
| Sole root compatibility export | `1d2f41c22e00e09877146e4e15d2f0b01eb29d67061c73363083c9abcd69428e` |
| Unchanged shared boundary verifier | `95c8a4320381ae971ce57234c20a8ae522009f515abeab48e888c12b1f3f3fc7` |

The first failed full runs and their complete downloaded logs remain immutable:

| Run | Event | Complete log and SHA256 |
| --- | --- | --- |
| [38087361439](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38087361439) | push | `/tmp/portable-ui-execution-own-ci-failure-diagnosis-attempt1/run-38087361439-complete.log` · `2dc0e86afb1843a6af51b776ee9f775be659dde3764211b0597ce0a2c782f286` |
| [38087364425](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38087364425) | pull_request | `/tmp/portable-ui-execution-own-ci-failure-diagnosis-attempt1/run-38087364425-complete.log` · `3b85d709da87ab7f9bd058c58ece884c06db7492992721a020ef08d2fad3954d` |

The separate source receipt records all other 1,493 tracked files as byte-exact:
`/tmp/phase5f-ui259-shared-boundary-source-d7d2a88/source-candidate-receipt.json`,
SHA256 `3a89716cf2370a1744959901e1f6c0bb4f5802df1606abecc2c1fae0d779081c`.
Scratch paths can disappear after environment replacement; the failure facts,
source identities and scope are retained here.

The prior [six actual directory/creation browser cases](PHASE_5F_DIRECTORY_AND_STORAGE_QUALIFICATION.md)
remain attached to their exercised `2f5d616` product and original implementation
path. They are not relabelled as fresh checks of this new head. This exact
implementation/re-export move requires the existing boundary checks, affected
compiler/module regressions, a fresh same-source build, and complete own-head
CI. It does not require repeating those six browser cases solely for a path
move. Separate real Templates default-pagination cases need their own fresh
fixture and receipt on the canonical-path source.

## Subsequent exact-head CI fixture failure

The initial repair record above retains its original source-only status. At
canonical repair/dated-roadmap head `781ebb6c0c0daee80cc1376b20c8f5d9f2dd434a`,
the separate pull-request Verify [38088625041](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38088625041)
passed native356 and the shared verification-scripts leaf, then failed the
source leaf: **405 files, 404 passed/1 failed; 3,787 cases, 3,786 passed/1 failed**.
All13 downstream leaves were skipped. Complete log:
`/tmp/portable-current-258-259-260-ci-closure-attempt1/38088625041-complete.log`,
SHA256 `b4679b9a8798dabeec5f187306ee1f8e2cce1a58758b2cda10dd16379912b2f9`.
No skipped leaf is counted as a pass, and this failure remains independent from
the earlier shared-boundary failure.

The held-original-stream native migration fixture's post-EOF `orphan` insertion
called `new Date().toISOString()` separately for `orphaned_at` and `updated_at`.
Crossing a millisecond violates the actual ledger CHECK that those fields are
equal for state `orphaned`. The minimal fixture repair captures one timestamp
per invocation and supplies it to both unchanged SQL parameters.

All production source, schema guards, hold-before-EOF rejection, exact original
stream bytes, released-hold count, post-EOF acceptance, delayed GC/provider
deletion and final media/alias/FK assertions are preserved. No fake clock,
timeout, test count, schema or production behavior changes. The corrected
fixture and replacement complete gates are **UNRUN** in this source checkpoint.

Separately, [the four genuine Templates browser cases](PHASE_5F_TEMPLATE_PAGINATION_QUALIFICATION.md)
passed at `3c69d4d` with the one owned strict, fresh same-source build and actual
owned shutdown/physical closure. That evidence does not turn this CI failure or
its13 skipped leaves into passes and does not qualify the changed fixture.
