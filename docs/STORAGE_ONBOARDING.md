# First external-storage setup

This guide covers the Worker storage-onboarding candidate introduced by the
[pre-main roadmap requirement](./PRODUCT_ROADMAP.md#pre-merge-storage-administration-onboarding-p0-for-315).
Implementation, exact-commit validation and deployed AWS acceptance are separate
evidence. Local Worker/browser fixtures do not establish real AWS operation or
authorize a live configuration change.

## Start with R2

The built-in R2 destination works without `INSTALLATION_SECRET_SEED` or
`STORAGE_CREDENTIAL_KEYRING`. Ordinary File uploads, administrator authentication
and read-only Storage Settings do not require external-credential encryption.
The future self-hosted LOCAL default must obey the same rule; this Worker feature
does not implement a new Node/LOCAL administration path.

Only an independently authorized system administrator adding storage whose
credentials the application must save needs this setup. The initial guided
provider is AWS S3. Cloudflare Access verification and `SYSTEM_ADMIN_EMAILS`
continue to control administrator access. A seed grants no administrator role.

Additional R2 profiles use actual deployment-owned bucket bindings and the exact
`R2_PROFILE_BINDINGS` mapping. They do not use an S3 candidate or an encryption
seed. Creating a candidate does not provision a bucket or grant provider access.

## Add the first AWS S3 profile

1. Open **Settings → Storage → Add storage → AWS S3**. The application checks
   credential-encryption readiness before asking for AWS access keys.
2. If this installation has no root and no protected credential history, choose
   **Generate seed**. Browser Web Crypto generates 32 random bytes. The canonical
   value is `sfi-seed-v1.` followed by the 43-character base64url encoding of those
   bytes. It is a 256-bit random root, not a password, PIN or phrase.
3. Choose **Copy seed** and retain a protected recovery copy. A seed created in
   this browser is temporary: it is not saved in browser storage or sent to an
   application API. Closing the setup can discard the displayed value. The UI
   cannot guarantee erasure of JavaScript memory or of the system clipboard.
4. In the existing Cloudflare deployment, open **Workers → Settings → Variables
   and Secrets**, add a **Secret** named `INSTALLATION_SECRET_SEED`, paste the
   complete value and apply the runtime configuration. Use an encrypted Worker
   runtime Secret. Do not use Workers Builds variables, plain `wrangler.jsonc`
   `vars`, an ordinary application setting or a D1 row.
5. Return to the application and choose **Recheck setup**. Continue only
   after the server reports that the configured root is ready. This step keeps
   the setup stage; no AWS access keys need to survive a reload.
6. Enter the AWS-issued access keys and the intended bucket, region, endpoint,
   root and expected bucket owner. The installation seed cannot generate AWS
   credentials, Cloudflare Access settings or third-party tokens.
7. Follow the existing storage stages below. A second or later S3 profile uses
   the same configured root and needs no further Cloudflare Secret addition.

The application Worker does not have permission to install its own runtime
Secret. One guided manual paste is the Worker setup boundary; the application
does not request a broad Cloudflare account API token. Trusted deployment-time
provisioning would need its own separately reviewed integration.

## Keep each storage stage explicit

| Stage | Meaning |
| --- | --- |
| Save candidate | Save the connection identity and encrypted credentials as a versioned draft. |
| Test connection | Run the bounded write/read/metadata/delete probe and retain its exact result and cleanup outcome. |
| Review evidence | Check that the successful result matches the current candidate and credential revision. |
| Register profile | Admit the qualified native identity using the existing registration receipt. |
| Activate | Explicitly approve the profile's runtime capability after its required checks. |
| Select upload destinations | Independently select internal/original upload defaults; this is a separate authorized change. |

Saving or testing does not activate storage or change defaults. Existing Files
keep their recorded physical destinations. Moving them is an explicit, verified
File Migration job. Failed, cancelled or uncertain operations keep their original
identifiers for reconciliation; the wizard must not create a replacement mutation
merely because a response was lost.

Existing File authority and native-profile activation prerequisites still apply.
The wizard reports those conditions; it does not switch File authority, enable
executors or rebind R2. An active-installation browser fixture is distinct from
the ordinary fresh R2 upload case.

Native S3 admission remains limited to the qualified AWS commercial-partition
path and its owner/namespace checks. Generic S3-compatible, WebDAV and SWITCHdrive
candidates do not become native write destinations through this wizard. Their
adapter and admission qualification remain separate. A local S3 fixture is useful
transport evidence but is not a real-provider release test.

## Preserve the installation root

An existing `STORAGE_CREDENTIAL_KEYRING` installation continues to use its
versioned keyring without a new seed or automatic conversion. Keep its recorded
key IDs, historical ciphertext, protected connection-test snapshots and recovery
material. Re-enveloping current credentials does not prove an older key can be
retired; retained snapshots and backups can still require it.

Configure exactly one authoritative root mechanism. If both the legacy keyring
and the installation seed are present, external-credential operations fail closed
with a configuration conflict, including when one configured value is empty or
malformed. Do not resolve that state by deleting or replacing
the original root without identifying and backing up the installation's existing
protected material. The application never guesses precedence or silently
re-envelops credentials.

| Readiness state | Operator action |
| --- | --- |
| `setup_required` | First external-credential setup is permitted; generate and protect a new seed. |
| `legacy_ready` | Continue with the existing keyring; no seed setup is needed. |
| `seed_ready` | Continue with the configured seed; later profiles reuse it. |
| `restore_required` | Restore the installation's original seed/key and required historical keys. Do not create a replacement root. |
| `configuration_conflict` | Resolve the conflicting deployment configuration while preserving the original authoritative root. |
| `unavailable` | Recheck when the current configuration/database can be read; do not infer a fresh installation. |

Readiness is administrator-only and reports safe state, not root bytes or
decrypted provider credentials. Missing, malformed or incorrect existing roots
must not cause a reset. A syntactically valid new seed does not recover ciphertext
encrypted by an earlier seed. Restoring a database containing protected storage
settings also requires its matching root and historical key material.

Metadata-only legacy recovery remains supported: when protected payloads and
check snapshots are absent, a configured legacy keyring may accept explicitly
re-entered provider credentials as a new revision. Retaining missing plaintext
still fails. A new seed cannot adopt that metadata as a fresh installation.
Concurrent first protected writes are serialized even when legacy key IDs match.

The server derives application-owned credential keys from the seed using a fixed,
versioned HKDF-SHA-256 contract. Derived keys retain the existing authenticated
AES-256-GCM envelope, identity-bound AAD and explicit key IDs. The seed remains in
the protected runtime secret store. It is not stored in D1, Git, URLs, logs,
telemetry, browser persistence or ordinary application exports. Provider
credentials remain encrypted at rest and are never returned to the browser.

The version-1 derivation contract is fixed in
[`installation-secret-seed.ts`](../worker/storage/installation-secret-seed.ts):

| Parameter | Exact value |
| --- | --- |
| KDF | HKDF-SHA-256 with the decoded 32-byte seed as input key material |
| Salt, UTF-8 | `sample-fabrication-workflow:installation-secret-seed:hkdf-sha256:v1` |
| Credential-key info, UTF-8 | `sample-fabrication-workflow:storage-credential-encryption:aes-256-gcm:v1` |
| Credential-key output | Non-extractable AES-256-GCM key with encrypt/decrypt usage |
| Key-ID info, UTF-8 | `sample-fabrication-workflow:storage-credential-key-id:v1` |
| Key-ID output | Separate 128-bit HKDF result, encoded as `seed-v1-` plus 32 lowercase hexadecimal characters |

The fixed public salt requires no per-installation random-salt backup. Recovery
still requires the original seed and the protected installation data. Changing
the format version, salt or purpose strings changes derived keys and requires
explicit historical-key handling. Canonical encoding and byte-length checks do
not prove the entropy of an operator-supplied value; use the browser's CSPRNG
generation rather than a handwritten value or a hash of a password.

Changing or rotating a seed is not a new first-time setup. Root conversion,
rotation and retirement require separately reviewed re-enveloping and recovery
support. This feature preserves the existing legacy-key rotation path; it does
not invent an automatic seed-rotation operation.

For Node/self-hosted deployments, retain the existing protected private-keyring
file configuration and its owner/permission checks. This Worker guide does not
claim that the Node runtime accepts `INSTALLATION_SECRET_SEED`. A future local
default does not need external-credential setup.

## Finite acceptance before release

The exact reviewed implementation and its current merge preview need their own
checks. Earlier green commits and historical screenshots do not qualify a newer
candidate.

| Unit | Required evidence |
| --- | --- |
| A — conditional setup | Fresh R2 upload and read-only settings without a root; first-S3 setup before AWS credential entry; 32-byte CSPRNG output, Copy and recheck; later S3 additions without repeated setup; no seed or plaintext browser persistence. |
| B — derivation and compatibility | Independent derivation/encryption/decryption across runtime restarts and configuration reloads; purpose/version separation; unchanged legacy envelopes, snapshots and recovery; wrong but well-formed roots, malformed roots and dual-root conflict; in-flight root changes revoke S3 work. |
| C — storage lifecycle | Genuine Worker/admin/reader and responsive browser flows; exact-request recovery after lost acknowledgements; stale revisions, provider failure, cancellation, pending cleanup and account switching; no implicit activation, default change or File movement. |
| D — installation and release | One protected runtime-Secret addition for first S3, none for the second; recoverable root backup; supported-provider documentation; current-commit complete gates and scoped real AWS/deployed acceptance. |

Use actual local Worker, native D1/R2 and signed Access browser cases for local
acceptance. Keep real AWS credentials and root values out of reports, screenshots
and uploaded artifacts. Local provider fixtures must be labeled as fixtures.
Deployed validation must confirm the effective runtime Secret and serving version,
provider requests and exact cleanup; it must not be inferred from a local build.

If user-addable AWS S3 is advertised in PR #315's main release, units A–D are a
pre-main gate. Otherwise explicitly defer this UX, effectively restrict
unqualified S3 mutation/activation in both UI and server, and document the release
scope. Basic R2 must continue to work without the optional bootstrap. This guide
does not authorize creating Secrets, changing remote D1, rebinding R2, activating
executors/providers, moving Files or merging main.

Heavy validation runs locally or in GitHub Actions. The minimal Cloudflare
build/upload path and the checked-in daily cron are unchanged by this setup.
