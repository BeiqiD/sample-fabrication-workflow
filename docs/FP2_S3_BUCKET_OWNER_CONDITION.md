# FP2 S3 bucket-owner condition

Status: implemented for review after merged candidate evidence #245 (`5992307`).
Final validation and deployment evidence are recorded in the associated PR.

S3 connection checks already bind the complete saved configuration and credential
envelope. This slice adds an optional AWS bucket-owner condition to that captured
configuration. It is one prerequisite for provider namespace qualification, not
native File admission or an activation receipt.

## Supported condition

`S3StorageNamespace.expectedBucketOwner` is an optional canonical 12-digit AWS
account ID. It is accepted only for standard HTTPS AWS S3 general-purpose bucket
service endpoints: `s3.amazonaws.com` with `us-east-1`, or
`s3.<region>.amazonaws.com` with the matching region. Custom domains, gateway path
prefixes, nondefault ports, access-point aliases and directory/table buckets are
outside this condition's support. Dotted bucket names require path-style access.
The root remains an object-key prefix rather than an endpoint path.

The adapter includes `x-amz-expected-bucket-owner` in both the request and SigV4
signed headers for GET, HEAD, PUT and DELETE. AWS checks this condition before
processing the operation; a different owner returns an access-denied response.
The adapter preserves its existing safe failure results, manual redirect policy
and no-retry behavior. It never removes the condition and retries a denied call.

This is deliberately not a generic S3 compatibility claim. For example, R2's
S3 compatibility table marks this header unsupported. Existing generic S3/R2
candidates continue to work without the optional field; a successful check on
them does not establish provider account identity. An empty form field omits the
property, preserving existing serialized configurations and check digests.

## Revisions and retained work

The owner condition is part of the immutable full configuration revision and its
check digest. Adding, changing or removing it saves a new candidate revision;
the new revision inherits no previous successful check. Accepted checks and
cleanup keep the exact old owner condition along with their captured credentials.
The current readiness report continues to compare the full configuration digest,
captured source fields and envelope fields, so it requires no new response format.

Candidate address identity continues to mean endpoint/bucket/root. This slice
does not reinterpret existing physical namespace digests or prevent edits to
unactivated candidates. Future native activation must persist and compare a
separate qualified provider identity, including the accepted AWS owner condition,
and reject credential/configuration changes that would reinterpret that identity.
Neither a configured account ID nor an older successful check alone is an
activation authorization or a guarantee of current connectivity.

## Compatibility and next boundary

No migration, native File admission, role-default change or archive format change
is included. Ordinary V19 content export and paused isolated recovery retain their
current contracts. Current accepted uploads keep their R2 destinations. The
administrator policy and credential keyring remain deployment-managed.

Focused qualification covers strict endpoint/account validation, signatures for
all four methods, owner-denied operations, UI create/edit/omission, and native
workerd/D1 check snapshots, revision invalidation and cleanup after a candidate
edit. The provider fixture enforces the owner condition but is not live AWS
acceptance. Real provider qualification remains outstanding.

Next: implement the provider-specific native identity/admission boundary with its
matched successor schema and archive/recovery support, then atomic activation
and independent defaults. Generic S3 and WebDAV need their own reviewed account
identity mechanisms; they cannot borrow AWS's owner-condition guarantee.

## Provider references

- [AWS bucket-owner condition](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-owner-condition.html)
- [AWS GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html), [HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html), [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html), [DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)
- [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
