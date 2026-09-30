# FP2 configuration security foundation

Base: merged #238 (`15a9a613`). The FP2 work starts with reusable authorization
and credential encryption modules. Candidate persistence and its Settings UI
follow in the same configuration track; these modules alone do not install
configuration routes or change the selected storage profiles.

## Administrator boundary

`SYSTEM_ADMIN_EMAILS` is an independent deployment variable. Settings management
requires an email supplied by verified Access authentication and explicitly
included in this policy. General application access and
`FILE_EVIDENCE_OPERATOR_EMAILS` do not confer system administration. Local-mode
authentication does not confer this permission. No actual administrator emails
are committed to configuration files.

Future administrator routes mount `requireSystemAdministrator` after the normal
authentication boundary. Capability reads use the same policy. Candidate
configuration maintenance must remain available during recovered File execution
pause, through its exact separately authorized route prefix.

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

The helpers return a replacement envelope and the expected old envelope for the
future persistence service's compare-and-swap. That service must commit the
envelope, candidate revision and safe audit metadata in one transaction.

## Rotation and recovery

1. Add a new key to the keyring while retaining the old keys, then select the new
   key ID. New envelopes use that key and a fresh nonce.
2. Re-envelop existing credentials through the privileged service using exact
   row/envelope revisions. Configuration and credential identities remain stable.
3. Remove an old key only after checking online envelopes and the protected
   database copies or retained envelopes that must remain recoverable.

Restore the matching keyring with an installation database containing encrypted
credentials. If a required key is unavailable, preserve the envelope and report
unavailable; a key cannot be reconstructed from its ciphertext.

Ordinary Sample/Project content packages exclude system configuration, credential
descriptors, root keys and credential payloads. The following candidate-registry
schema must separate descriptors eligible for a separately authorized metadata
archive from protected payloads: candidate revisions reference descriptors, and
payloads reference those descriptors in the reverse direction. A configuration-
metadata restore preserves metadata and opaque credential references, starts
paused, and requires administrators to re-enter missing credentials. A successor archive
must explicitly declare that credential recovery boundary and the permission for
including system configuration. V19 remains frozen.

## Following slice

Implement immutable external candidate revisions, encrypted credential storage,
safe operation audit and administrator-only save/read routes, then their Settings
UI. Provider capability tests and atomic activation follow. Before independent
role defaults can be edited, all accepted ingestion paths must use the shared
purpose-to-role selection and retain each accepted profile/revision.

## Qualification

Six administrator authorization cases and seventeen credential encryption cases
passed, including actual Node/workerd interoperability and key rotation. The
complete project TypeScript check passed. These checks qualify the foundation
modules; administrator configuration editing still requires the persistence and
route integration above.
