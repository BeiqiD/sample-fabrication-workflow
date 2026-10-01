# FP2 configuration security foundation

Base: merged and deployed #238 (`15a9a613`). This FP2 slice adds administrator
authorization, immutable candidate configuration revisions, encrypted credential
persistence, safe operation audit, and candidate editing in Storage Settings.
Saving a candidate performs no provider I/O and changes no active profile or
role default. Provider tests and activation remain the following slice.

## Administrator boundary

`SYSTEM_ADMIN_EMAILS` is an independent deployment variable. Settings management
requires an email supplied by verified Access authentication and explicitly
included in this policy. General application access and
`FILE_EVIDENCE_OPERATOR_EMAILS` do not confer system administration. Local-mode
authentication does not confer this permission. No actual administrator emails
are committed to configuration files.

Administrator routes mount `requireSystemAdministrator` after the normal
authentication boundary. Capability reads use the same policy. Candidate
configuration maintenance must remain available during recovered File execution
pause, through its exact separately authorized route prefix. Ordinary signed-in
users continue to read existing storage status, but cannot list or save external
candidates or obtain credential material.

## Candidate persistence

Migration `0014_fp2_storage_configuration.sql` adds five installation tables:

| Table | Purpose | Ordinary content export |
| --- | --- | --- |
| `system_storage_profiles` | Stable provider and namespace identity, latest candidate revision | Excluded |
| `system_storage_configuration_revisions` | Immutable labels, configuration revisions and opaque credential references | Excluded |
| `system_storage_credential_descriptors` | Credential ownership and authenticated configuration context | Excluded |
| `system_storage_credential_payloads` | Revisioned encrypted envelopes | Excluded |
| `system_storage_configuration_audit` | Actor, operation, outcome and saved revision | Excluded |

Native `storage_profiles`, accepted operations, File authority and role defaults
are unchanged. An existing candidate uses an expected-revision comparison;
concurrent or stale changes conflict instead of replacing a newer revision.
The candidate address is immutable for a profile. Changing its endpoint, bucket
or root requires a new candidate profile. This address digest is not yet proof
of a provider's physical namespace: a generic WebDAV endpoint may resolve a
different home folder for another username. Provider testing and activation must
bind the actual provider account/home scope and reject any revision that would
reinterpret an activated namespace, requiring a new profile instead. No candidate
in this slice has active File locations or selected role defaults.

## Credential encryption

`STORAGE_CREDENTIAL_KEYRING` is a Cloudflare Worker Secret. Its versioned JSON
contains the current key ID and a map of AES-256 keys encoded as canonical
base64. The root keys stay outside Git and the database. A keyring is needed
before browser credential editing becomes available; native R2 use continues
without external credential setup.

Each envelope uses AES-GCM and a random 96-bit nonce. Authenticated context binds
the format version, profile ID, configuration revision, credential reference,
namespace digest and key ID. An envelope copied to a different configuration
cannot be decrypted as that configuration. Browser responses expose configured
or unavailable status, never plaintext credentials or envelope payloads.

The helpers return a replacement envelope and the expected old envelope for
compare-and-swap. Persistence commits the envelope, candidate revision and safe
audit metadata in one transaction. Retaining credentials for a new configuration
revision decrypts the prior envelope and encrypts a fresh envelope in the new
authenticated context; it does not copy ciphertext into another context.

## Installation setup

In the Worker deployment, set `SYSTEM_ADMIN_EMAILS` to the comma-separated
Access emails permitted to administer system storage. Keep this Variable in the
Dashboard; `keep_vars: true` retains it across deployment. File evidence operator
permission does not automatically confer this separate permission.

Create `STORAGE_CREDENTIAL_KEYRING` as a **Secret**, using a fresh 32-byte key.
For example, run this on the administrator's own computer and paste the resulting
JSON directly into the Cloudflare Secret field:

```sh
node -e "console.log(JSON.stringify({version:1,currentKeyId:'key-2026-10',keys:{'key-2026-10':require('node:crypto').randomBytes(32).toString('base64')}}))"
```

Keep the keyring with the installation's protected recovery material. Do not
commit the generated JSON or share it in issue reports. After deployment,
`/settings/storage/configuration` lets the authorized administrator save external
drafts. Saving a draft does not contact that provider or change upload defaults.

## Rotation and recovery

1. Add a new key to the keyring while retaining the old keys, then select the new
   key ID. New envelopes use that key and a fresh nonce.
2. A future privileged rotation operation can re-envelop existing credentials
   using exact row/envelope revisions. The current helpers support this operation;
   this slice does not expose an installation-wide rotation command.
3. Remove an old key only after checking online envelopes and the protected
   database copies or retained envelopes that must remain recoverable.

Restore the matching keyring with an installation database containing encrypted
credentials. If a required key is unavailable, preserve the envelope and report
unavailable; a key cannot be reconstructed from its ciphertext.

Ordinary Sample/Project content packages exclude system configuration, audit,
credential descriptors, root keys and credential payloads. The current writer
continues V19: it projects only the explicitly classified five system tables and
their owned schema objects out of the content schema artifact. The frozen V19
table catalog, validators and content-schema fingerprint are unchanged. Unknown
application tables remain visible and still fail the reviewed fingerprint.
Full deployment migration observation continues to include the complete schema.
Shadow inspection uses the same content projection so candidate configuration
does not invalidate existing content evidence.

Isolated content recovery omits the exact system-only `0014` migration as well as
the earlier deployment-only test cleanup. It neither restores encrypted payloads
nor installs candidate administration tables; content recovery keeps execution
paused as before. This content ZIP is not an installation credential backup.

The candidate registry separates metadata from protected payloads: revisions
reference descriptors, and payloads reference those descriptors in the reverse
direction. A future separately authorized configuration-metadata archive can
preserve metadata and opaque references without ciphertext, start paused, and
require administrators to re-enter missing credentials. Any archive that includes
system configuration must explicitly declare that permission and recovery
boundary. V19 does not acquire that permission in this slice.

## Following slice

Provider capability tests and atomic activation follow candidate editing. Before independent
role defaults can be edited, all accepted ingestion paths must use the shared
purpose-to-role selection and retain each accepted profile/revision.

## Qualification

The foundation has six administrator authorization cases and seventeen credential
encryption cases, including Node/workerd interoperability and key rotation.
Candidate persistence, route authorization, UI and content-export isolation are
qualified together with this slice's focused checks and required CI. Live editing
needs a deployment-managed `SYSTEM_ADMIN_EMAILS` policy and
`STORAGE_CREDENTIAL_KEYRING` Secret; their actual values are never committed.
