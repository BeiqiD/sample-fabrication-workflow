# Retained bb3 full source CI failure

Push Verify38086577043 on `bb3b1736b38a66b2edc37617d208f37dd61b4b28` passed native verification and failed source tests: 407 files passed and two failed; 3841 cases passed and two failed. Thirteen downstream gates were skipped. The exact raw log is retained with its SHA256 and original failure excerpts in the companion receipt.

`worker/export-v8-protocol.test.ts:84` observed41 queries against the expected40. `worker/reference-routes.test.ts:165` observed three direct queries against the expected two. Static inspection identifies the newly added local-profile schema presence probe before the existing identity presence probe, both following the generation metadata probe. The canonical row/schema snapshot remains a single batch.

This checkpoint preserves the failures before proposing a correction. It changes no product/test/configuration source, query-budget assertions, raw SQL, schema/catalog pins or historical proofs. No local compiler, test, build or database ran; Execution30 owns the runtime window. The separate557 source correction remains unqualified by local runtime. V26 stays provisional metadata-only with no local provider/default-role authority activation.
