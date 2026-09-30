# FP1 basic Storage Settings

Implementation base: accepted #233, `6df9e1b4`, 2026-09-28.

This records the original authenticated, read-only subset of FP1 Settings,
delivered in #234. The [R2 role-default slice](./FP1_R2_ROLE_DEFAULTS.md) extends
its metadata projection after #236's File authority activation.
It can proceed alongside historical evidence collection because it neither
changes file authority nor requires those missing facts. Complete catch-up and
atomic authority activation still gate File-authoritative R2 role defaults;
administrator-controlled configuration, secrets and S3 remain later work.

## User-facing boundary

`/settings/storage` shows the current upload destinations, deployment
configuration and registered storage profiles. The Settings navigation entry
opens this page. Refresh reads metadata only.

At the #234 checkpoint, the upload paths were not yet a universal role policy: ordinary R2
uploads and original Comment file uploads follow their existing R2 and managed
storage paths respectively. A profile admitted for shadow reads or writes is
not a business default. The page does not label a registered profile as the
default or claim that all originals already use R2.

Configuration presence and a matching registered namespace do not establish
provider connectivity or byte integrity. Connection health is explicitly
`not_checked`. This page neither invokes the existing Comment connection check
nor stores, edits, tests or activates provider credentials.

## Backend boundary

`GET /api/settings/storage` uses the application's existing authenticated API
boundary and returns a safe, versioned projection with private, no-store cache
headers. A single bounded primary-database statement reads the authority
control, runtime guard and registered profiles with their runtime companions.
The response includes at most 100 profiles and indicates truncation.

Deployment configuration is parsed with the same pure namespace parsers used by
the existing bound adapters. Matching is against exact physical namespace
identity and supported configuration metadata; equal provider type alone is
insufficient. The read model never creates or updates a profile and never opens
a provider connection. Incomplete or invalid configuration remains explicit;
it is not silently replaced with a different destination.

The public projection excludes namespace identities, account/bucket names,
provider URLs and roots, credentials and credential references, object keys and
actor identities. Errors are bounded and generic rather than raw environment,
provider or SQL exception text. Authority and shadow access describe recorded
state; neither grants an operation capability.

The `/api/storage/status` connection check belongs to Comment original uploads.
The role-default extension makes it check the active original destination while
legacy/overlap retain the managed-storage path. It is not automatically polled
by Settings. No configuration mutation endpoint or provider binding is introduced
by the read-only Settings surface.

## Qualification and remaining work

Focused backend coverage checks authentication, cache/error privacy, one
bounded primary snapshot, exact configuration matching, truncation and absence
of provider I/O or database writes. UI coverage checks loading, refresh,
failure, obsolete responses and honest configuration/connection labels.
Required CI and a deployed Settings read are the rollout checks.

The actual post-fix V17 ZIP already passed 10/10-file isolated recovery after
#233. Under the owner's accepted verification cadence, this metadata-only
feature does not require another live ZIP export or restore. The evidence and
major-change trigger are recorded in the
[implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md#accepted-zip-and-validation-cadence).

The owner has authorized permanent disposal of the six old test Projects that
contain the seven ambiguous references. Migration `0011` and a fresh catch-up
checkpoint handle that separate operational step. Settings does not perform the
cleanup or activate File authority. File-aware runtime integration and the
operator activation shipped in #236 and became Active/Enabled on 2026-09-30.
The role-default extension reports R2 before first upload as `pending_bootstrap`
and the persisted policy afterward as `configured`; both describe the selected
destination without claiming connection health. Privileged role/default editing
and configuration tests remain FP2 work with their own authorization and lifecycle
boundaries.
