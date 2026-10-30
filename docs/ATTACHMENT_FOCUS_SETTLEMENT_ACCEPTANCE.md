# Await attachment modal focus settlement

PR #253's mounted run on `7cdee51` failed the original parent-modal containment
assertion after removing the last Comment attachment. The isolated original
22-case file reproduced that same failure: 21 passed and one failed at line90.

React removes portal DOM before passive modal cleanup restores focus. Waiting
only for alertdialog absence can observe that intermediate state. The test now
awaits both original assertions together: active focus must be inside the parent
and have the exact `Comment attachments` label. Product modal/focus code,
assertions and default deadlines are unchanged; no arbitrary sleep is added.

The candidate file passed all22 cases. A separate private negative control
disabled the exact fallback-focus operation, confirmed the suppression executed,
and failed the targeted containment assertion as expected (one failed,21 skipped).
Those skips belong only to the selected negative control. All three clients
exited; no full mounted/final remote gate is claimed by this focused run.

[Condensed receipts](ATTACHMENT_FOCUS_SETTLEMENT_RECEIPTS.json) retain the
original remote and local failures, candidate pass, negative control, commands
and hashes. They support the cleanup-settlement explanation without claiming
a timing trace from the remote runner. Final integrated complete CI is pending.
