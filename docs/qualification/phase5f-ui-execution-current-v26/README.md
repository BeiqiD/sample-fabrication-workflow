# Current V26 UI and Execution integration qualification

Exact source `98d81a170394a140fb63e970b31d1985bd56f68d`, tree
`62d67e1c9fb3d59d74c49e0eceebe4ef2975ffe4`, completed the six required local
gates across two bounded attempts on 2026-10-10. The first actual run passed
shared ownership for 122 files, the owned canonical-witness strict check,
original stream/migration6, mounted37 and Project/source38. All five commands
exited0 and their direct children were reaped; all 81 test cases passed.

The original [attempt1 wrapper receipt](attempt1/finite-runtime-completion-receipt.json)
remains **FAIL**. Its owner checker lost an already observed kernel `Z` state
when reading two descendants' FD directories returned `PermissionError`.
It stopped before build and recorded signals to only its original owned group.
The retained [actual diagnosis](attempt1/owned-post-failure-diagnosis.json)
and [independent root reconciliation](root-owner-reconciliation.json) establish
four empty groups and two `Z`/PPID1 descendants with exited kernel resources.
Inaccessible FD metadata is retained; it is not an observed zero-FD count.
No unowned parent was reaped, and no test/assertion/budget was changed.

After the narrow state-preserving wrapper correction and independent source
review, the [sole build continuation](build-attempt2/finite-runtime-completion-receipt.json)
ran only the original `npm run build` and passed. Its direct child exited0 and
was actually reaped; one `Z`/PPID1 descendant had exited kernel resources with
FD metadata still inaccessible. No cleanup signal or live owned process remained.
The first five commands were **not rerun**. These results establish local gate
qualification across the two attempts, not a rewritten six-stage PASS run.

The [qualification receipt](qualification-receipt.json) hashes 35 retained
original files and 118 fresh build artifacts. All source90/currentV26-114 pins
and the clean source head were rechecked after both attempts. The historical
six directory/creation browser cases at `2f5d616`, four Templates browser cases
at `3c69d4d`, and current24 Execution cases at `4928ce9` retain their own actual
sources and scopes. No fresh combined browser/Execution12/performance run or
old121-artifact equality is claimed.

Separately, merged #258's [post-merge receipt](post258/receipt.json) records actual
[Verify38090002753](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38090002753)
and [Map38090002713](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38090002713)
success with all15 contexts: source409 files/3843 cases and mounted103 files/985
cases. The [step interpretation](post258/step-skip-interpretation.json) retains
the skipped conditional failure-cleanup step, which is not a verification leaf.
Complete raw Actions logs remain at their hashed original `/tmp` paths and
immutable Actions URLs. These are not deployed serving/schema/provider claims.

Root owns the identical-tree ancestry join retaining published781, final259
publication and exact-head complete push/PR Verify/Map gates before merge.
Those final-head gates remain open. Close260 as superseded only after successful
combined merge, preserving its independent history. Full Node application/File
writer/Docker, active membership, provider/production and physical-device scopes
remain separate roadmap work.
