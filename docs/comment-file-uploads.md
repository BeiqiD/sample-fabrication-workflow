# Comment file uploads

All sample notes and process-step comments use the same two-stage submission
model.

## Storage boundaries

- Processed inline comment images use the existing private `ASSETS` R2 binding.
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
SWITCH edu-ID password. The Worker checks the credentials with a read-only
`PROPFIND` request before the UI enables file attachments. File bytes are
streamed unchanged to SWITCHdrive; parent directories are created lazily.
Attachments belonging to one sample are placed below a human-readable
`samples/<sample-code>--<sample-id>/comment-attachments/` folder. A comment
shared across multiple samples is stored once below `shared-comment-attachments/`
instead of silently duplicating the original file.

Provider-specific key naming, requests, and authentication must stay inside a
`ManagedStorage` implementation; comment routes must not contain Google Drive,
OneDrive, SWITCHdrive, or other provider-specific logic.

## Authentication

Application authentication and storage authentication are separate:

1. Cloudflare Access authenticates the person creating or retrying a
   submission.
2. The Worker authenticates to the configured external file storage. No
   storage credential reaches the browser.
3. An OAuth-backed adapter should keep refresh tokens in encrypted
   server-side secrets and store only a connection/secret reference, provider,
   account label, status, and expiry in D1. It must expose the same
   `ManagedStorage` methods and report unavailable or expired authentication
   through `/api/storage/status`.

Do not put OAuth access or refresh tokens in D1 records, local storage, comment
metadata, upload URLs, or client logs.

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

Apply `migrations/0005_comment_submissions.sql`. No additional R2 bucket is
required. Until all SWITCHdrive secrets are configured and the WebDAV
credential check succeeds, users can submit text, compressed comment images,
and attachment links, but cannot upload original files.

## Upload integrity

- Comment images are decoded and converted to WebP in the browser, then
  independently hashed by the Worker.
- Managed attachments are sent as the original `File` body without
  transformation. The browser supplies a SHA-256 hash, and the storage adapter
  streams the body unchanged.
- Submission and item IDs make create, upload, retry, and finalize operations
  idempotent. Successfully uploaded items are not uploaded again.
- Cancelled or abandoned storage objects are marked for cleanup. A scheduled
  cleanup handler can remove provider objects after the retention period
  without changing the composer or submission API.
