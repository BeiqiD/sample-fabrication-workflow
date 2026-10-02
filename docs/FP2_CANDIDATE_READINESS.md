# FP2 candidate check evidence

Status: implemented and independently reviewed on 2026-10-02, based on deployed fresh
acceptance role selection #244 (`0b7299ca`). Final CI and deployment evidence are recorded in the associated pull request. This read-only report distinguishes retained check
history from evidence for the exact current candidate and credential envelope.
It does not contact a provider, write database state or enable activation.

## Administrator report

`GET /api/storage/configuration/readiness?profileId=…&expectedRevision=N` requires
the independent verified-Access system-administrator policy at both the HTTP
and service boundaries. It uses private/no-store responses. General application
or File evidence operator access does not grant permission. The report remains
available while recovered File execution is paused.

The request names the candidate revision the administrator is viewing. An absent
candidate returns 404. A changed revision or source context returns 409, so a
concurrent edit cannot produce a report assembled from incompatible snapshots.
Unavailable report infrastructure returns a fixed safe 503 response without
database or credential details.

The service computes the configuration digest from the parsed current namespace
JSON and authenticates the credential envelope, then obtains the final report
through a guarded primary SQL snapshot. Each of the two reads uses a fresh
first-primary session. The final read compares the complete captured stored
source tuple: profile and latest configuration revision, credential
descriptor/reference, namespace JSON and stored namespace digest, and every
envelope field including its revision. It does not recompute the physical
namespace digest. The computed configuration digest is compared with each
check's recorded digest when classifying evidence; the current configuration
row does not store that digest. Envelope replacement during authentication
invalidates the report even when the configuration revision is unchanged.

Responses expose safe credential availability/authentication and envelope
revision metadata, aggregate check counts and the ID/date of the latest success
matching the complete current context. They never expose key IDs, keys, nonce,
ciphertext, provider credentials, probe keys or private provider error text.

## Evidence and history

The report covers all retained checks for the profile, including rows beyond the
50-result history panel:

| Evidence | Meaning |
| --- | --- |
| Current configuration successes | Successful receipts matching the complete current configuration, namespace and credential descriptor; the envelope itself may be historical |
| Historical configuration successes | Successful receipts that do not match that current configuration tuple |
| In-progress work | Receipts with a recorded running check or running cleanup |
| Unconfirmed cleanup | Every receipt whose cleanup is not `confirmed_absent`, including `pending` and `absence_observed` |
| Latest exact-context success | Latest successful receipt also matching every field of the current credential envelope, reported by ID and date |

A credential re-enveloping operation leaves immutable check receipts unchanged.
Their success remains historical evidence for the same configuration, but a
snapshot of the previous envelope is no longer an exact match for the current
envelope. An `already_current` operation preserves the authenticated envelope
and therefore preserves an existing exact match. A new candidate revision does
not inherit evidence from an earlier configuration.

An unavailable deployment keyring can coexist with a retained receipt whose
captured tuple exactly matches the stored current tuple. The report may retain
that matching historical evidence while declaring the credential unavailable;
the match establishes neither credential usability nor current connectivity.
Every successful probe is dated evidence. No expiry interval or ongoing provider
health guarantee is inferred from it.

This GET does not reconcile expired execution or cleanup leases. In-progress
counts describe persisted state, including an expired lease that has not been
reconciled by the existing check-status flow. The existing status and cleanup
routes retain their mutation and provider-work semantics. Unconfirmed cleanup
stays visible across all retained history even when a later independent check
succeeds.

## Configuration page

Each candidate has a compact expandable **Check evidence** panel. It displays
the report for the selected revision and invalidates it after relevant candidate,
check, cleanup and credential-maintenance operations. A changed selection,
superseded request or revoked administrator capability cannot present an old
report as current evidence.

The report keeps activation unavailable. A passed probe still does not establish
the physical provider account scope required for immutable native admission.
Native File admission for S3 and independent mutable defaults require the corresponding
runtime and accepted-policy support plus a paired successor archive/recovery
contract. Neither this report nor the shared purpose selector supplies those
capabilities.

## Compatibility and qualification boundary

This slice adds no migration, system table or content format. Native schema
guards, the V19 table catalog and fingerprint stay frozen. V7–V19 isolated
recovery retains its paused execution boundary. Current upload roles continue
to select the admitted bootstrap R2 profile under the immutable defaults;
accepted operations continue to use their recorded destinations.

Local focused qualification passed on 2026-10-02:

| Qualification | Passing tests |
| --- | ---: |
| Strict contract, primary source guards, authenticated envelope status and all-history aggregation | 36 |
| HTTP boundaries and native Worker/D1/AES-GCM integration | 7 |
| Safe browser client | 13 |
| Mounted configuration, encryption and evidence UI, including stale responses and operation invalidation | 42 |

The native fixture preserves real SQL guards and verifies 55 retained receipts,
unchanged expired leases and check snapshots, no provider calls or writes during
report reads, and concurrent configuration/envelope changes returning 409.
Independent review found no remaining blockers. Full regression, production
build and deployment evidence are tracked in the associated pull request.

The current live actor remains read-only. Real administrator re-enveloping and
real-provider candidate acceptance still require the deployment-managed policy
and Secret. Actual keys, credentials and administrator addresses stay outside
Git and issue reports. The accepted FP1 original-file round trip and V19 recovery
remain evidence without another routine upload or ZIP rehearsal.
