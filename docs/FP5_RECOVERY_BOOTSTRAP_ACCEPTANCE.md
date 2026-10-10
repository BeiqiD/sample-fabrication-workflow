# FP5 recovery binding deployment qualification

Status: bounded local defect repair passed, 2026-10-10; combined-tree and actual
development rollout remain separate gates.

The generator already supported a separately configured `RECOVERY_DB`, but the
pre-migration bootstrap guard required exactly one D1 binding. A valid optional
recovery installation therefore failed before migration. The guard now compares
the named source database and optional recovery database, including exact IDs,
names and `RECOVERY_TARGET_ID`, alongside the existing account, Worker and R2
namespace identity. Binding order is incidental; identity is not.

The guard rejects missing/partial, aliased, duplicated, extra, preview or remote
database bindings and an orphaned target ID. Invalid or mismatched identities
retain the redacted failure before any migration. Source and recovery database
provisioning, freshness admission and executor grants remain separate operations.

| Check | Actual result |
| --- | --- |
| Pre-fix actual-generator/redirect guard reproduction | 0 passed / 1 failed for the valid configured recovery target |
| Applied bootstrap suite | 11 passed / 0 failed; includes bidirectional drift and identical malformed configuration rejection |
| Root independent bootstrap review run | 11 passed / 0 failed |

Detailed local logs: `/tmp/cloudflare-recovery-bootstrap-red.log`,
`/tmp/cloudflare-recovery-bootstrap-green.log` and
`/tmp/cloudflare-recovery-bootstrap-root-review.log`. These are isolated
configuration/guard tests. No Cloudflare account resource, remote schema,
provider activation or traffic configuration was changed.

The [development integration runbook](V3_DEVELOPMENT_INTEGRATION_RUNBOOK.md)
documents the paired forward migrations, exact deployment identity, Access and
operational admission limits. A successful build alone cannot qualify the actual
serving version, current schema or fresh recovery target.
