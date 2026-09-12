import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagedStorageStatus } from "../../shared/types";
import { api } from "./api";

interface StorageStatusResult {
  status: ManagedStorageStatus | null;
  error: string | null;
}

let pendingStatus: Promise<StorageStatusResult> | null = null;

function loadManagedStorageStatus() {
  // Share only an in-flight query. A later mount or explicit retry must be able
  // to observe recovered connectivity or a changed storage configuration.
  pendingStatus ??= api.getManagedStorageStatus().then(
    (status) => ({ status, error: null }),
    () => ({
      status: null,
      error: "File storage status could not be loaded. Retry to enable file attachments; attachment links remain available.",
    }),
  ).finally(() => { pendingStatus = null; });
  return pendingStatus;
}

export function useManagedStorageStatus() {
  const [result, setResult] = useState<StorageStatusResult | null>(null);
  const [checking, setChecking] = useState(true);
  const active = useRef(false);

  const check = useCallback(async () => {
    if (active.current) setChecking(true);
    const next = await loadManagedStorageStatus();
    if (active.current) {
      setResult(next);
      setChecking(false);
    }
    return next;
  }, []);

  useEffect(() => {
    active.current = true;
    void check();
    // The shared request may still serve another mounted composer.
    return () => { active.current = false; };
  }, [check]);

  return { result, checking, check };
}
