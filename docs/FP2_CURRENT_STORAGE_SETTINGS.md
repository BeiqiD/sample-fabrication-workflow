# Current Storage Settings and activation controls

This is local development work paired with the native File runtime generation
and its successor archive. It does not record a deployed environment change or
real-provider qualification.

The primary Settings page requests `GET /api/settings/storage?version=3`.
The bare endpoint and explicit version 2 retain the frozen V2 projection;
unsupported activated native graphs fail there with a private generic error.
Historical databases without the successor policy tables still return validated
V2 metadata to the current client.

The V3 projection includes the actual paired `internal` and `originals` profile
IDs and their policy revision. It retains an unavailable selected profile rather
than substituting another destination. Profile availability is a read-only
observation of local configuration and authenticated credentials, with no
provider requests. It exposes the nullable installation binding revision and
registered, unavailable, available or retired status. Namespace identities,
provider addresses, credential references, payloads and actor identities are
excluded. Connection health remains `not_checked`. A restored writable native
profile with portable history but no local binding is visible as unavailable.
Writable historical SWITCHdrive profiles can remain locally available for
existing File operations, while new upload role choices support R2 and S3.

Additional registered R2 instances use the optional deployment-owned
`R2_PROFILE_BINDINGS` JSON object. Each key is a registered profile ID and its
value contains exactly `namespaceIdentity` (the canonical R2 namespace JSON
string) and `bindingName` (the actual uppercase environment bucket binding).
The exact registered namespace must match, and different physical namespaces
cannot alias one bucket capability. This mapping does not create profiles or
prove provider connectivity. V3 resolves each profile independently, so a valid
mapped instance remains available when the bootstrap namespace or binding is
broken. Its bound bucket must expose the normal get/head/put/delete interface.
The frozen V2 projection continues to describe only bootstrap configuration.

System administrators can choose the two defaults independently. The browser
saves both choices using `PUT /api/settings/storage/defaults`, the observed
policy revision and one operation ID. Registration's exact evidence panel
offers the separate activation operation using the current candidate revision,
credential envelope, successful check and observed binding revision.
`POST /api/storage/configuration/activations` enables the profile's installation
binding; choosing it for new uploads remains a separate Settings action.
The server owns current administrator, File execution and source fences.
A missing local binding uses a null expected revision; the server continues
the portable activation history when creating the new installation binding.

Both controls retain only their nonsecret operation intent in session storage.
A lost response is reconciled by GET of its durable receipt; retry requires an
explicit click and repeats the original input and identifier. A policy conflict
requires refreshed settings, and stale activation evidence is discarded.
CAS expectations govern an uncommitted mutation. Once an operation commits,
replay validates its immutable selected targets and candidate/check/revision
context and returns the retained receipt, even when current defaults or local
bindings have since changed. It does not apply another mutation.
Paused File execution leaves Settings readable and disables new mutations.
Existing files retain their recorded locations after a default change.

Focused qualification covers unavailable selected S3 without R2 fallback,
independent role availability, read-only registration, restored missing local
bindings, authenticated paused reads, bounded private response validation,
administrator controls, CAS conflict, lost receipts and original-intent replay.
It also covers independent R2 mappings, missing bootstrap isolation and selected
destinations outside a truncated profile page.
The frozen V2 mounted cases remain covered through the current client.
