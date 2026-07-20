# Architecture

## Runtime

The application is one Cloudflare Worker deployment. React/Vite serves the interface, Hono serves `/api`, D1 stores relational state, and a private R2 bucket stores workbooks and images.

```mermaid
flowchart TD
  U[Authenticated browser] --> A[Cloudflare Access]
  A --> W[Worker: UI and Hono API]
  W --> D[(D1)]
  W --> R[(Private R2)]
```

## Security boundary

- Production is fail-closed: `AUTH_MODE` is `access` in `wrangler.jsonc`.
- Every API route except the shallow `/api/health` endpoint validates the `Cf-Access-Jwt-Assertion` signature, issuer, and application audience against the team's rotating JWKS.
- `ALLOWED_EMAILS` can add an application-level email allowlist after JWT validation.
- Unsafe browser requests must have the same `Origin` as the Worker.
- `/api/ready` is authenticated and verifies both D1 and R2 bindings.
- R2 is private; assets are returned only by authenticated application routes.

## Data invariants

- Sample codes and template version numbers are unique in D1.
- A recipe family owns immutable versions. A version is editable only before its first run-plan reference; the first reference atomically locks it.
- Step definitions and expected diagram states are content-addressed. Recipe versions, plans, and runs reference their hashes, so repeated content is stored once.
- A physical sample has at most one active run. Finished runs form an ordered predecessor chain; the successor anchors to the previous run's last actual step.
- Each run has immutable plan revisions. A newer version of the same recipe family can replace only unfinished future work; completed and ad-hoc execution remains in the chain.
- Run rows store actual overrides only when they differ from the hashed recipe definition. Comments, deviation reasons, execution diagrams, and ad-hoc steps remain sample-specific.
- State verification is a sparse chain independent of recipe metrology steps. Each verification snapshots the run steps covered since the previous valid verification and records matched or mismatched outcome.
- Sample state changes and their history events are emitted by database triggers.
- Dedicated bench records update sample state and append the manual event in one D1 batch, guarded by the caller's last-seen timestamp and a per-mutation identifier.
- Step state, notes, optional attachment event, sample timestamp, and run rollup are one D1 batch.
- Every user-originated record stores the validated Access email.
- Ordinary R2 uploads are registered in `assets`; failed registration removes the object.
- Every new workbook, manifest, imported diagram, and ordinary image receives a SHA-256. Ready assets are unique by hash, so repeated content reuses one private R2 object even when filenames differ.
- A FabuBlox import remains pending while bounded D1 batches write content-addressed rows. Pending or failed versions are hidden; a failed import removes newly uploaded R2 objects and releases their hashes for retry.

## Platform limits

Bulk inserts keep each statement below D1's 100-bound-parameter limit. A confirmed import is capped at 180 steps and 40 images, uses at most five concurrent R2 writes, and divides persistence into bounded batches behind the pending-import visibility gate.

Full export reads all tables through one D1 batch for a consistent database snapshot, then downloads the referenced private assets into a browser-generated ZIP. The manifest contains stable relative paths and no authentication URLs.
