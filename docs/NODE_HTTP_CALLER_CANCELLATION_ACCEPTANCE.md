# Node endpoint body cancellation retains transport ownership

Actual Node HTTP prototype attempt1 passed7/8 cases; genuine chunked4097-byte
login returned500 rather than its intended413. The credential parser cancelled
its bounded Fetch reader, which made Node Readable.toWeb destroy the downstream
stream with AbortError. The transport mistook this deliberate consumption end
for an upload failure and masked the endpoint response. The narrow native socket
negative control retained the same500 result.

The bridge now marks only its own consumer cancellation with a private exact
sentinel. It detaches that downstream stream while retaining IncomingMessage
byte counting, complete-upload validation, deadline and actual disconnect
ownership. Other stream/handler errors still fail. A trusted optional ingress
callback receives the exact Request, IncomingMessage and actual Server before
handler dispatch; absence preserves the existing composition.

Original15 HTTP/static cases plus4 real-socket cancellation scopes passed19/19.
Controls retain endpoint413, bounded drain-before-success, later global overflow,
incomplete408, actual disconnect abort and unrelated handler500. Root applied
those exact two source files, passed strict server/runtime types and reran19/19.
[Owner receipts](NODE_HTTP_CALLER_CANCELLATION_RECEIPTS.json) and
[applied receipts](NODE_HTTP_CALLER_CANCELLATION_APPLIED_RECEIPTS.json) retain
source/log hashes and failed/passing attempts. Independent source review found
no concrete blocker at the exact final production/test hashes.

Separately, the genuine local-auth HTTP library14/14 and partial composed
prototype8/8 passed at the fixed source. Its original8 test bodies are unchanged.
Both prototype attempts retain their10 isolated synthetic fixture directories.
That private prototype uses a qualified23-migration candidate and attested old
client build, but does not activate canonical0023, physical writer ownership,
local File profiles, Docker or any of its21 unavailable business owners. It is
not full RT1–RT6 acceptance. Final integrated15-leaf qualification remains open.
