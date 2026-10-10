# First actual current V26 qualification attempt

The actual source was `a823dda035109a69d094c9ef51ab308f1f834534`, tree `656aaabb710615b19bc787889916c131ee31a03f`. It has actual merged development commit913 as its second parent and is byte-identical to the reviewed bb3 tree. This result does not borrow historical d79 qualification.

The first six compiler commands passed. The seventh, expanded `.tsconfig.v26-worker-tests.json`, failed with TS6133 for the unused `ReferenceTarget` import in `worker/projects/service.ts:23`. The runner stopped immediately. Five later compilers and every Vitest, Node, smoke and build stage remain UNRUN. Exact command output, preflight and actual receipt are retained without editing.

All source/config/raw/frozen pins were unchanged after the attempt. Every owned fixture path remained empty, no new workerd process remained, and the unowned preexisting PID44327 was left untouched. The runtime window was explicitly released before source diagnosis or adaptation.

Static inspection identifies a one-line unused type import left by shared business read extraction. The live `ReferenceTargetType` import is still used. No source correction is applied in this checkpoint; root review coordinates that mature service path. Compiler strictness, test registration and original budgets remain unchanged. V26 remains provisional metadata-only, the operational Node catalog stays V25, and no local File/role/provider authority is enabled.
