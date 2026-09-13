# Bridge writer preparation (stage B)

This is an **inactive S1 implementation**, prepared separately from stage C.
It cannot run against the currently deployed S0 schema or the contracted S2
schema, and must not be merged into an automatically deploying S0 branch.
No active migration or deployment configuration is changed here.

The serving-version retirement, recovery, rollback and migration prerequisites in
[the compatibility design](BACKEND_COMPATIBILITY_CLEANUP_DESIGN.md) still apply.
Pre-A Workers must be retired before canonical occurrences receive empty
compatibility placeholders. B must precede C so that B readers can consume C's
legacy-only writes. E/A Workers must be retired before C begins those writes.
Passing these local qualifications is not evidence of remote version retirement.

## Transitional behavior

B reads legacy text from `run_step_comments.legacy_body` and canonical text from
`comment_submissions.body`. Canonical finalization omits the old occurrence
`body` column, letting S1 supply its empty placeholder. Legacy insertion writes
the same trimmed text to both `body` and `legacy_body`, preserving the older E
reader during their overlap. This dual write is the distinction from C, which
writes `legacy_body` only and can therefore tolerate S2's dropped column.

The five runtime changes preserve HTTP request/response shapes, guards,
statement order, event writes, actor metadata and identity generation. The extra
legacy column has one corresponding placeholder and equal body binding;
canonical finalization removes its obsolete column, placeholder and binding.
B4's `RETURNING id`, exact acknowledgement set and uncertain-result handling
remain intact.

## Reproducible qualification

Run from this preparation checkout, including a shallow checkout of its draft:

```sh
node --test scripts/backend-bridge-writer.test.mjs
npx tsc -p tsconfig.worker.json
```

The script uses the inactive S1 SQL fixture with disposable databases only. It
builds actual B, E and C Worker bundles and invokes their HTTP routes against the
same host SQLite or real workerd D1 database. The bundles share R2 on workerd.

E and C bundles do not depend on another local worktree, Git history, a network
fetch or mocked reader responses. Tracked patches under
`scripts/fixtures/backend-bridge/` restore the exact reviewed E and C source
files into a new temporary directory. Each of the five affected files must then
match its tracked SHA-256 before esbuild can substitute it. E needs a five-file
patch; C differs from B only in the one legacy INSERT, while all five C files are
still verified. The remaining modules come from the unchanged integration
source. A patch or source mismatch fails the test rather than approximating an
older implementation.

Qualification covers:

- B common/individual and text/image-only creation, actual canonical image
  upload, reference resolution/search and Sample detail. Every new B legacy row
  has equal body columns; canonical occurrences retain a null legacy body and
  empty compatibility body.
- Actual E Sample detail and reference resolution of B-created legacy and
  canonical occurrences. Actual E legacy creation and canonical finalization
  remain readable by B, including the trigger-inclusive D1 acknowledgement.
- Actual C legacy creation followed by B reads, then B dual writes followed by
  C reads, for common and individual scopes. Alternating writes preserve earlier
  occurrence identities and text exactly. This does not claim E can read C-only
  legacy text; the retirement requirement remains.
- Occurrence, canonical submission and image deletion/restoration, finalization
  retries, a committed-but-lost host D1 acknowledgement, stale common targets and
  a target trashed before finalization. Full row comparisons reject partial or
  duplicated side effects, followed by foreign-key and integrity checks.

These explicit S1 tests do not replace the ordinary S0 `verify:ci` gate or the
eventual complete gate for the selected active schema. This branch is a draft
implementation for review, not an authorized deployment transition.
