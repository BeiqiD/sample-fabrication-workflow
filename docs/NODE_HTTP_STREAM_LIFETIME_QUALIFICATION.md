# Node HTTP original stream lifetime qualification

The Node HTTP boundary now retains each admitted handler, original incoming
body reader, response pump and memoized disposer through settlement.
`stopNodeHttpServerAndDrain` seals admission synchronously and waits for these
owners before returning a successful transport drain. It retains a failed
cleanup and returns the same rejecting promise on subsequent calls.

A completed incoming message can still leave unread data in its original Web
reader. The boundary cancels that exact unread queue once before acknowledging
the response. During shutdown it sweeps idle sockets again after admitted
requests settle. Admitted requests retain their explicit request deadline while
their inherited socket idle timeout is cleared. Both changes were adopted for
the held Job request, which subsequently passed in its original five-second
budget; the recorded source and runtime evidence do not isolate the contribution
of either change or an internal socket owner.

The adopted product and two affected controls are byte-identical to source
`306773095a551ddfea27d3d35ec2ea6b573be3b9`. Its original Node 24 command was:

```sh
node --experimental-transform-types --test --test-concurrency=1 server/http.test.mts server/http-lifetime.test.mts server/static-assets.test.mts
```

The original process exited 0 in 1.568 seconds: HTTP 18, lifetime 10 and static 2
controls all passed; 0 failed, 0 cancelled, 0 skipped. The original process was
waited/reaped, its owned group was empty, and all 2493 source inputs and private
TMP pins remained exact. Negative cleanup controls preserve their expected
quarantine and do not claim a successful graceful drain.

The external recorder assumed TAP while this Node installation emitted SPEC.
Its original failure remains unchanged. An independent interpretation matched
all 30 unique original successful titles and the single complete SPEC footer.
The original receipt, full unmodified log, interpretation and formal closure are
[retained together](qa/NODE_HTTP_STREAM_LIFETIME_QUALIFICATION_20261011/).
No runtime repetition was used to replace the recorder failure.

This development adoption changes only the HTTP boundary, its two test files
and the existing HTTP test command. The original static implementation and
controls are unchanged. The current development ServerTS compiler passed once
on `889ba4228a979ae5cb2fc13da3db8e7657d377c7`: exit 0 in 1.243 seconds,
all 2353 source pins unchanged and the original owned process group empty.
Rebasing onto the qualified #268 merge preserved the entire source tree; later
changes add qualification records and roadmap text only. The original compiler
receipt and source peer retain their own head. Ordinary complete remote gates
remain required before merge. The donor's all-source
receipt remains scoped to its original head; importing its exact HTTP dependency
closure does not retag that receipt as a new all-source run.

Default application/native drain, configured LocalFile composition, jobs, Group
authority, executable startup and Docker remain separately qualified scopes.
