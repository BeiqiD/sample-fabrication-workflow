# Native upload deadline and Processing Retry follow-up

At service head `8537c1a`, push Verify passed, while PR Verify failed one of 19 native HTTP/static cases: an incomplete caller-cancelled upload received 400 instead of 408. The native Node request deadline can expire before the Fetch deadline; the custom `clientError` handler incorrectly classified `ERR_HTTP_REQUEST_TIMEOUT` as malformed HTTP. Only that native code now maps to 408. Malformed HTTP remains 400, header overflow remains 431, and all published timeout values and the original same-deadline test remain unchanged.

A new real-socket control first failed because its native header/request deadlines differed; that original fixture failure is retained. The corrected control against unchanged production recorded the genuine native timeout code and reproduced the 400 response. With the repair, the complete 20-case HTTP/static files and both mandatory server/runtime-test strict scopes passed.

Foundation post-merge Verify separately failed the grouped Processing Retry test after all source cases passed. Retry clears its alert when loading begins, before the eight-owner refresh publishes. The test now waits for the same three exact accepted object references. All seven mounted cases and client strict passed; production behavior, payload/count/atomicity assertions and default timeout remain unchanged.

The accompanying receipt retains both original remote failures, the failed first control, the meaningful before-fix failure and all successful local scopes. The complete new-head remote gates remain pending. This does not qualify a full Node application, local File/job composition, a deployed traffic version, or provider activation.
