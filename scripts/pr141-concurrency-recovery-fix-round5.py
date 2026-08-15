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
