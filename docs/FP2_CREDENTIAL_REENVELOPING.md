# FP2 credential encryption key re-enveloping

Status: implemented and independently reviewed on 2026-10-02, based on deployed candidate
checks #242 (`cf64d15`). This slice connects the existing AES-GCM rotation helper
to independently authorized administration and atomic persistence. It changes
the encryption wrapping of a credential, preserving its provider values and
authenticated profile/configuration identity. It performs no provider requests,
activation, upload-default changes or configuration revision creation.

## Administrator operation

After adding a fresh key to the deployment Secret and selecting it as the current
key, retain the previous keys. The candidate configuration page offers a
Credential encryption panel for each profile. It shows current and historical
retained credential envelopes, with safe revision and availability metadata.
An authenticated envelope using a retained previous key can be re-enveloped
under the current key. An unreadable or missing envelope remains unavailable;
the operation cannot reconstruct its key or replace its credential values.

Routes are under `/api/storage/configuration`:

| Method and path | Request and behavior |
| --- | --- |
| `GET /credential-envelopes?profileId=…` | Up to 100 retained descriptor/envelope metadata rows; reports whether more exist |
| `POST /credential-reenvelopes` | `{ operationId, profileId, revision, credentialRef, expectedEnvelopeRevision }`; atomically re-envelop or record that it already uses the current key |
| `GET /credential-reenvelopes/:operationId` | Read the immutable operation receipt, without reading plaintext or calling a provider |

The independent verified-Access administrator policy applies at both the HTTP
and service boundaries. Responses use private/no-store caching. POST accepts
only strict JSON within 4 KiB. Browser metadata and receipts contain no root
keys, key IDs, nonce, ciphertext, provider credentials or private error details.
Administration remains available during a recovered File execution pause.

## Atomicity and retries

Re-enveloping uses the unchanged descriptor identity as authenticated context.
Persistence compares the credential reference, envelope revision and every old
envelope field. The replacement uses a fresh nonce and advances the envelope
revision exactly once. The payload update and metadata-only audit receipt share
one D1 transaction. A failed comparison or failed receipt insertion rolls back
the entire operation, preserving the newer stored envelope.

An already-current envelope is authenticated before an `already_current` receipt
is recorded. It is not re-encrypted and its envelope revision does not advance.
Missing keys or authentication failures preserve the original ciphertext and
return a safe unavailable response.

The UUID operation ID is an idempotency identity. Repeating the same canonical
credential identity and expected envelope revision returns the existing receipt,
even if configuration or deployment keys have changed since completion.
Conflicting reuse returns 409. After a lost response the browser checks the
receipt, then may retry the same operation ID if no receipt exists. It retains
only this nonsecret intent in session storage and does not create a second
operation while the outcome is unresolved.

Historical candidate descriptors can be re-enveloped independently of the latest
candidate revision. This preserves their authenticated identity and allows old
retained credential payloads to be maintained without editing candidate history.

## Retained snapshots and recovery

Re-enveloping a descriptor payload does not rewrite an accepted candidate check's
immutable encrypted snapshot. Check cleanup continues to use the original
snapshot, provider context and probe key. Its encryption key must remain
available. A missing snapshot key leaves cleanup unavailable and does not cause
a provider request using different credentials.

This panel is not proof that an old key can be removed. Key retirement must also
account for retained check snapshots and protected installation database backups.
Keep the matching deployment keyring with each protected backup that must remain
recoverable. Ordinary content ZIPs do not contain these credentials or keys.

Migration `0016_fp2_credential_reenvelopes.sql` adds the installation-only,
append-only `system_storage_credential_reenvelopes` receipt table. It contains
safe operation/actor/revision metadata, not copies of encrypted payloads.
V19 content schema projection excludes exactly eight system tables and their
owned schema objects. Isolated V7–V19 content recovery skips the exact system-only
`0014`, `0015` and `0016` migrations. Unknown application objects remain visible
to the frozen content fingerprint. Content recovery stays paused as before.

## Qualification boundary

Focused qualification covers strict contracts, administrator authorization,
source-envelope conflicts, idempotent retries, unavailable keys, transaction
rollback, immutable receipts, historical payloads and browser reconciliation.
Native Worker/D1 qualification exercises real AES-GCM and transactional SQL,
including preserved check snapshots. These fixtures establish implementation
behavior; they do not claim privileged maintenance against deployment credentials.

Local qualification passed on 2026-10-02:

| Qualification | Passing tests |
| --- | ---: |
| Strict safe contracts | 4 |
| Receipt SQL constraints, populated-system V19 export/recovery and restore planning | 9 |
| Current schema chain and native D1 migration observation | 13 |
| Service faults, complete-source CAS, concurrent UUIDs and HTTP boundaries | 25 |
| Native Worker/D1, preserved R2 defaults and captured-context cleanup | 3 |
| Client and mounted configuration UI, including response loss and revocation | 36 |

The 90 focused checks passed, alongside Worker TypeScript and production build.
Native D1 confirms `changes()` fences the actual preceding UPDATE inside a batch:
distinct competing IDs yield one 200 and one 409, while identical concurrent IDs
return the same receipt and advance the envelope revision once. Required CI and
publication remain tracked through the PR.

The current live actor is read-only. Real administrator re-enveloping and real
S3 candidate acceptance still require the deployment-managed administrator
policy and Secret. Actual keys, credentials and administrator addresses stay
outside Git and issue reports. Native R2 remains the current upload destination
for both roles.
