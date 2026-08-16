# Comment file uploads

All Sample notes and process-Step Comments use the same two-stage submission
model.

## Body rendering boundary

A Comment body remains one authoritative plain string entered through the existing textarea. Displayed Sample-note and process-Step Comment bodies are rendered client-side with the shared safe GFM/TeX renderer; generated HTML and MathML are never persisted or accepted from a caller.

The renderer does not turn Comments into a document editor:

- the composer has no WYSIWYG state, block model, formatting toolbar, or preview-owned save path;
- images, unchanged files, and external links continue through the existing submission items and attachment controls;
- Markdown image syntax is rendered as a safe link rather than an inline image, so it cannot bypass attachment identity, upload integrity, lifecycle, or export rules;
- raw HTML is shown literally, unsafe URL schemes are rejected, and TeX expansion/size are bounded;
- Project Reading may use the same renderer core with document spacing and ordinary Markdown images, but that presentation policy does not change Comment storage.

The Comment renderer is lazy-loaded from published read surfaces. Uploading and failed recovery cards remain plain submission-state UI and do not load the renderer merely to show a local draft. The same status boundary applies when a non-ready process-Step Comment is projected into the Sample page's Notes & observations list: its body remains literal plain text until the submission becomes `ready`.

## Storage boundaries

- Processed inline Comment images use the existing private `ASSETS` R2 binding.
- Original files use the `ManagedStorage` interface in
  `worker/managed-storage.ts`.
- External links are database records only. The Worker never fetches or
  validates their targets.

There is deliberately no R2 fallback for original files. File attachment
controls remain disabled until an external file-storage adapter is configured
and its server-side authentication is valid. Comment images and external links
continue to work without a connected file-storage provider.

The first supported adapter is SWITCHdrive over its official HTTPS WebDAV
endpoint. It uses a dedicated SWITCHdrive App Passcode, never the user's
SWITCH edu-ID password. The Worker checks credentials with a read-only
`PROPFIND` request before the UI enables file attachments. File bytes are
streamed unchanged to SWITCHdrive; parent directories are created lazily.

Attachments belonging to one Sample are placed below a human-readable
`samples/<sample-code>--<sample-id>/comment-attachments/` folder. A Comment
shared across multiple Samples is stored once below
`shared-comment-attachments/` instead of silently duplicating the original
file.

Provider-specific key naming, requests, and authentication stay inside a
`ManagedStorage` implementation; Comment routes do not contain Google Drive,
OneDrive, SWITCHdrive, or other provider-specific logic.

## Authentication

Application authentication and storage authentication are separate:

1. Cloudflare Access authenticates the person creating or retrying a
   submission.
2. The Worker authenticates to the configured external file storage. No
   storage credential reaches the browser.
3. An OAuth-backed adapter keeps refresh tokens in encrypted server-side
   secrets and stores only a connection/secret reference, provider, account
   label, status, and expiry in D1. It exposes the same `ManagedStorage`
   operations and reports unavailable or expired authentication through
   `/api/storage/status`.

Do not put OAuth access or refresh tokens in D1 records, local storage, Comment
metadata, upload URLs, exports, or client logs.

## SWITCHdrive configuration

Configure these values as Worker secrets in the Cloudflare dashboard:

- `MANAGED_STORAGE_PROVIDER=switchdrive`
- `SWITCHDRIVE_WEBDAV_URL=https://drive.switch.ch/remote.php/dav/files/USERNAME/`
- `SWITCHDRIVE_USERNAME=<username shown with the App Passcode>`
- `SWITCHDRIVE_APP_PASSWORD=<dedicated App Passcode>`
- `SWITCHDRIVE_ROOT=sample-fabrication-workflow`

All five can be entered as secrets so the WebDAV account path and username are
not exposed in deployment logs. The adapter accepts only the official
`drive.switch.ch` HTTPS WebDAV endpoint. It does not follow or fetch
user-supplied URLs.

## Deployment

Apply `migrations/0005_comment_submissions.sql`. The rich-text presentation
follow-up adds no migration, API field, or additional R2 bucket. Until all
SWITCHdrive secrets are configured and the WebDAV credential check succeeds,
users can submit text, compressed Comment images, and attachment links, but
cannot upload original files.

The v3 integration branch remains blocked from remote migration/deployment
until the blob lifecycle gate in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md#v3-deployment-gate) is
satisfied.

## Upload integrity

- Comment images are decoded and converted to WebP in the browser, then
  independently hashed by the Worker.
- Managed attachments are sent as the original `File` body without
  transformation. The browser supplies a SHA-256 hash, and the storage adapter
  streams the body unchanged.
- Submission and item IDs make create, upload, retry, and Finalize operations
  idempotent. Successfully uploaded items are not uploaded again.
- Ordinary Delete of a ready Comment or attachment occurrence is soft deletion;
  it does not remove the canonical submission, occurrence identity, or shared
  bytes needed for Restore and complete export.
- Cancelled or explicitly retry-closed storage objects may become cleanup
  candidates after the retention period, but age alone does not make a
  retryable submission unreachable.
- Retryability must be represented by one explicit authoritative state read by
  retry routes, Cancel, scheduled cleanup, and the retention-edge surface.
- A shared managed object or R2 asset remains protected while any ready,
  soft-deleted, archived, unfinished, retryable, or future Project source can
  still use or export it.
- Cancelling one deduplicated submission must not orphan bytes used by another
  unfinished or retryable submission.
- Cancel and scheduled cleanup use the same reachability predicate, re-check it
  before physical provider deletion, and remain safe when Finalize, retry,
  Restore, or new deduplicated attachment creation wins a concurrent race.
- Provider deletion is scheduled work. Cancel never removes bytes directly in
  the request path.

The authoritative reachability, export-warning, permanent-delete, test, and
migration/deployment rules are maintained in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md). The next implementation
PR is planned in
[blob lifecycle implementation plan](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md).
