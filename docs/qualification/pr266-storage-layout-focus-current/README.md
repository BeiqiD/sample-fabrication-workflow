# Current metadata and Storage focus repair

The complete Sample, Timeline, Execution and Comment metadata extraction remains
exactly at original4e. Its push Verify and both Map checks passed, but PR Verify
38114671135 failed the original Storage Refresh focus assertion: the native DOM
focus remained on body instead of returning to the enabled button. All15 status
contexts were success; that did not qualify the failed complete PR run. The
original annotations and four runs are retained byte for byte here.

Sourceff643 changes only the Storage page focus effect from a passive effect to
a layout effect, plus its import and explanation. Layout effects consume the
intent with the committed enabled DOM before a later click can queue another
refresh ahead of the prior passive effect. Independent review read the complete
component, original two tests and installed React commit/flush code. This is a
source-supported ordering repair; the CI annotation alone does not identify its
actual scheduling trace. Initial reads keep focus unchanged and the existing
body-or-same-button guard preserves focus moved to another control.

One affected app compiler and the original two mounted focus controls passed at
ff643. The original child was waited and reaped, its process group was empty,
and all2126 source pins and private temporary-directory identities remained
unchanged. Other mounted tests were unselected, not passes. No new browser or
frontend build was run. The original56 metadata controls remain at their
original commits and import closures; the repair does not alter their source.

PR264 merged normally at31a2cfe, exactly preserving the qualifiedbcc279 tree,
after its own four complete runs and15 statuses passed. Its post-merge CI is a
separate scope. PR265 post-merge Verify38112946658, Map38112946661 and all15
statuses passed, as recorded separately in the adopted original4a573 receipt.
The new coherent PR266 head still requires its own complete push/PR Verify and
Map runs and all15 status contexts. This development change does not establish
serving, provider admission, current browser, whole Node/File/Job or Group
qualification.
