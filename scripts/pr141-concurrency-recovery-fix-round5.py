from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "worker/blob-lifecycle/registration.ts",
    '''  return new BlobRegistrationAuthorityUnavailableError(
    detail,
    error instanceof BlobReuseProviderUnavailableError
      ? error.message
      : undefined,
  );
''',
    '''  return new BlobRegistrationAuthorityUnavailableError(
    detail,
    error instanceof BlobReuseProviderUnavailableError
      || detail.includes("pending FabuBlox import")
      ? detail
      : undefined,
  );
''',
)

replace_once(
    "migrations/0028_blob_registration_and_recovery_reconciliation.sql",
    "manaed_storage_objects",
    "managed_storage_objects",
)

replace_once(
    "worker/comment-submission-routes.ts",
    '''  if (!c.req.raw.body || !item.filename || !item.mime_type || !item.byte_size) {
    throw new HTTPException(400, { message: "The upload body is missing" });
  }
  const declaredSize = Number(c.req.header("x-upload-size"));
''',
    '''  if (!c.req.raw.body || !item.filename || !item.mime_type || !item.byte_size) {
    throw new HTTPException(400, { message: "The upload body is missing" });
  }
  const uploadByteSize: number = item.byte_size;
  const declaredSize = Number(c.req.header("x-upload-size"));
''',
)

replace_once(
    "worker/comment-submission-routes.ts",
    '''    let storageObject = await reusableCommentManagedObject(
      c.env,
      storage.provider,
      sha256,
      item.byte_size,
    );
''',
    '''    let storageObject = await reusableCommentManagedObject(
      c.env,
      storage.provider,
      sha256,
      uploadByteSize,
    );
''',
)

replace_once(
    "worker/comment-submission-routes.ts",
    '''        const registration = await registerManagedObject(c.env, storage, {
          id: storageObjectId,
          objectKey: key,
          originalName: item.filename,
          mimeType: contentType,
          byteSize: item.byte_size,
          sha256,
''',
    '''        const registration = await registerManagedObject(c.env, storage, {
          id: storageObjectId,
          objectKey: key,
          originalName: item.filename,
          mimeType: contentType,
          byteSize: uploadByteSize,
          sha256,
''',
)

replace_once(
    "worker/comment-submission-routes.ts",
    '''          findWinner: () => reusableCommentManagedObject(
            c.env,
            storage.provider,
            sha256,
            item.byte_size,
          ),
''',
    '''          findWinner: () => reusableCommentManagedObject(
            c.env,
            storage.provider,
            sha256,
            uploadByteSize,
          ),
''',
)
