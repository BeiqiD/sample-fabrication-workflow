import { captureApplicationOwner, type ApplicationOwner } from "./authentication-client";

export type CheckpointStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const prefix = "application-checkpoint-v1:";
export function checkpointKey(key: string, owner: ApplicationOwner): string {
  return owner.subject === null ? key : `${prefix}${encodeURIComponent(owner.subject)}:${key}`;
}

/** Bind storage when the operation or page starts, before any asynchronous
 * preparation. Unowned keys from older clients stay untouched and are never
 * silently assigned to whoever next signs into the browser. */
export function checkpointStorage(owner: ApplicationOwner = captureApplicationOwner(), supplied?: CheckpointStorage): CheckpointStorage {
  const namespace = checkpointKey("", owner);
  const store = () => { owner.assertCurrent(); return supplied ?? sessionStorage; };
  const keys = () => {
    const storage = store(), result: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key !== null && (namespace ? key.startsWith(namespace) : !key.startsWith(prefix))) result.push(key.slice(namespace.length));
    }
    return result;
  };
  return {
    getItem(key) { return store().getItem(namespace + key); },
    setItem(key, value) { store().setItem(namespace + key, value); },
    removeItem(key) { store().removeItem(namespace + key); },
    key(index) { return keys()[index] ?? null; },
    get length() { return keys().length; },
  };
}

const unownedPrefixes = ["research-package-", "system-recovery-", "file-migration-", "storage-profile-", "storage-role-policy:",
  "storage-credential-", "storage-configuration-", "r2-upload-request-v1:", "metrology-reference-upload-v1:",
  "comment-acceptance-v1:", "fabublox-import-request-v1", "project-trash-recovery:", "storage-candidate-check:"];
export function hasUnownedBrowserCheckpoints(): boolean {
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (key && unownedPrefixes.some(prefix => key.startsWith(prefix))) return true;
    }
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith("file-shadow-pilot-operation-v1") || key?.startsWith("file-shadow-evidence-adjudication-v1")) return true;
    }
  } catch { /* Durable mutations provide their own storage-unavailable errors. */ }
  return false;
}
