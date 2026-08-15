import { primaryD1 } from "../d1-primary";
import type { ManagedStorage } from "../managed-storage";
import type { Env } from "../types";
import {
  BlobReuseProviderUnavailableError,
  type ReusableManagedObject,
  type ReusableR2Asset,
} from "./reuse";

type R2RegistrationCandidate = ReusableR2Asset & {
  status: "pending" | "ready";
};

type ManagedRegistrationCandidate = ReusableManagedObject & {
  status: "failed" | "ready" | "orphaned";
};

export class BlobRegistrationAuthorityUnavailableError extends Error {
  constructor(
    detail: string,
    readonly publicMessage =
      "Asset registration outcome could not be verified. Retry later.",
  ) {
    super(`Blob registration authority is unavailable: ${detail}`);
    this.name = "BlobRegistrationAuthorityUnavailableError";
  }
}

export class ManagedRegistrationByteSizeMismatchError extends Error {
  constructor() {
    super("Managed provider reported a different byte size");
    this.name = "ManagedRegistrationByteSizeMismatchError";
  }
}

function authorityUnavailable(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return new BlobRegistrationAuthorityUnavailableError(
    detail,
    error instanceof BlobReuseProviderUnavailableError
      || detail.includes("pending FabuBlox import")
      ? detail
      : undefined,
  );
}

async function readR2RegistrationCandidate(
  db: D1Database,
  input: { id: string; objectKey: string; sha256: string },
): Promise<R2RegistrationCandidate | null> {
  return primaryD1(db).prepare(`
    SELECT a.id, a.r2_key, a.original_name, a.mime_type,
           a.byte_size, a.sha256, a.status
    FROM assets a
    WHERE a.id = ? AND a.r2_key = ? AND a.sha256 = ?
      AND a.import_id IS NULL AND a.status IN ('pending', 'ready')
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
          AND biq.object_key = a.r2_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
          AND bg.object_key = a.r2_key
          AND bg.state IN ('deleting', 'deleted')
      )
  `).bind(input.id, input.objectKey, input.sha256)
    .first<R2RegistrationCandidate>();
}

async function readManagedRegistrationCandidate(
  db: D1Database,
  input: {
    id: string;
    provider: string;
    objectKey: string;
    sha256: string;
    byteSize: number;
  },
): Promise<ManagedRegistrationCandidate | null> {
  return primaryD1(db).prepare(`
    SELECT mso.id, mso.provider, mso.object_key, mso.original_name,
           mso.mime_type, mso.byte_size, mso.sha256, mso.status
    FROM managed_storage_objects mso
    WHERE mso.id = ? AND mso.provider = ? AND mso.object_key = ?
      AND mso.sha256 = ? AND mso.byte_size = ?
      AND mso.status IN ('failed', 'ready', 'orphaned')
      AND NOT EXISTS (
        SELECT 1 FROM blob_integrity_quarantine biq
        WHERE biq.store_kind = 'managed'
          AND biq.provider = mso.provider
          AND biq.object_key = mso.object_key
      )
      AND NOT EXISTS (
        SELECT 1 FROM blob_gc_ledger bg
        WHERE bg.store_kind = 'managed'
          AND bg.provider = mso.provider
          AND bg.object_key = mso.object_key
          AND bg.state IN ('deleting', 'deleted')
      )
  `).bind(
    input.id,
    input.provider,
    input.objectKey,
    input.sha256,
    input.byteSize,
  ).first<ManagedRegistrationCandidate>();
}

async function findR2Winner(
  findWinner: () => Promise<ReusableR2Asset | null>,
) {
  try {
    return await findWinner();
  } catch (error) {
    throw authorityUnavailable(error);
  }
}

async function findManagedWinner(
  findWinner: () => Promise<ReusableManagedObject | null>,
) {
  try {
    return await findWinner();
  } catch (error) {
    throw authorityUnavailable(error);
  }
}

export interface RegisterR2AssetInput {
  id: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  actorEmail: string;
  bytes: ArrayBuffer;
  findWinner: () => Promise<ReusableR2Asset | null>;
}

export interface R2AssetRegistration {
  asset: ReusableR2Asset;
  deduplicated: boolean;
}

/**
 * Register an R2 object without ever creating provider-only state.
 *
 * Metadata is durably staged before the provider PUT. A response loss before
 * that claim therefore creates no object, while a failure after PUT leaves a
 * pending row that ordinary GC can enumerate. Promotion is guarded against a
 * concurrent ready winner; the losing candidate remains a uniquely addressed,
 * tracked GC candidate and is never allowed to delete the winner's locator.
 */
export async function registerR2Asset(
  env: Env,
  input: RegisterR2AssetInput,
): Promise<R2AssetRegistration> {
  const initialWinner = await findR2Winner(input.findWinner);
  if (initialWinner) {
    return { asset: initialWinner, deduplicated: true };
  }

  const id = input.id;
  const now = new Date().toISOString();
  let candidate: R2RegistrationCandidate | null = null;
  let insertError: unknown;

  for (let attempt = 0; attempt < 2 && !candidate; attempt += 1) {
    try {
      await env.DB.prepare(`
        INSERT INTO assets (
          id, r2_key, original_name, mime_type, byte_size, status,
          actor_email, created_at, sha256
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).bind(
        id,
        input.objectKey,
        input.originalName,
        input.mimeType,
        input.byteSize,
        input.actorEmail,
        now,
        input.sha256,
      ).run();
      candidate = {
        id,
        r2_key: input.objectKey,
        original_name: input.originalName,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        sha256: input.sha256,
        status: "pending",
      };
    } catch (error) {
      insertError = error;
      try {
        candidate = await readR2RegistrationCandidate(env.DB, {
          id,
          objectKey: input.objectKey,
          sha256: input.sha256,
        });
      } catch (verificationError) {
        throw authorityUnavailable(verificationError);
      }
      if (candidate) break;

      const winner = await findR2Winner(input.findWinner);
      if (winner) return { asset: winner, deduplicated: true };
      if (attempt === 1) throw authorityUnavailable(error);
    }
  }
  if (!candidate) {
    throw authorityUnavailable(
      insertError ?? new Error("R2 registration metadata could not be staged"),
    );
  }
  if (candidate.status === "ready") {
    const { status: _status, ...asset } = candidate;
    return { asset, deduplicated: false };
  }

  await env.ASSETS.put(input.objectKey, input.bytes, {
    httpMetadata: { contentType: input.mimeType },
  });

  let promotionError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let promoted = false;
    try {
      const result = await env.DB.prepare(`
        UPDATE assets
        SET status = 'ready'
        WHERE id = ? AND r2_key = ? AND sha256 = ?
          AND import_id IS NULL AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM assets winner
            WHERE winner.id <> assets.id
              AND winner.sha256 = assets.sha256
              AND winner.status = 'ready'
              AND NOT EXISTS (
                SELECT 1 FROM blob_integrity_quarantine biq
                WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
                  AND biq.object_key = winner.r2_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM blob_gc_ledger bg
                WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
                  AND bg.object_key = winner.r2_key
                  AND bg.state IN ('deleting', 'deleted')
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM assets staged
            JOIN imports owner ON owner.id = staged.import_id
            WHERE staged.id <> assets.id
              AND staged.sha256 = assets.sha256
              AND staged.status IN ('pending', 'ready')
              AND owner.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM blob_integrity_quarantine biq
                WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
                  AND biq.object_key = staged.r2_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM blob_gc_ledger bg
                WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
                  AND bg.object_key = staged.r2_key
                  AND bg.state IN ('deleting', 'deleted')
              )
          )
      `).bind(id, input.objectKey, input.sha256).run();
      promoted = Boolean(result.meta.changes);
    } catch (error) {
      promotionError = error;
    }
    if (promoted) {
      return {
        asset: {
          id,
          r2_key: input.objectKey,
          original_name: input.originalName,
          mime_type: input.mimeType,
          byte_size: input.byteSize,
          sha256: input.sha256,
        },
        deduplicated: false,
      };
    }

    let exact: R2RegistrationCandidate | null;
    try {
      exact = await readR2RegistrationCandidate(env.DB, {
        id,
        objectKey: input.objectKey,
        sha256: input.sha256,
      });
    } catch (verificationError) {
      throw authorityUnavailable(verificationError);
    }
    if (exact?.status === "ready") {
      const { status: _status, ...asset } = exact;
      return { asset, deduplicated: false };
    }

    const winner = await findR2Winner(input.findWinner);
    if (winner) {
      try {
        await env.DB.prepare(`
          UPDATE assets
          SET status = 'failed', sha256 = NULL
          WHERE id = ? AND r2_key = ? AND status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM blob_retention_edges bre
              WHERE bre.store_kind = 'r2' AND bre.provider = 'r2'
                AND bre.object_key = assets.r2_key
            )
        `).bind(id, input.objectKey).run();
      } catch {
        // The pending row still makes the uniquely addressed candidate
        // discoverable to GC; winner resolution must not delete either locator.
      }
      return { asset: winner, deduplicated: true };
    }

    if (!exact) {
      try {
        await env.DB.prepare(`
          INSERT INTO assets (
            id, r2_key, original_name, mime_type, byte_size, status,
            actor_email, created_at, sha256
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `).bind(
          id,
          input.objectKey,
          input.originalName,
          input.mimeType,
          input.byteSize,
          input.actorEmail,
          now,
          input.sha256,
        ).run();
      } catch (error) {
        promotionError = error;
      }
    }
    if (attempt === 1) {
      throw authorityUnavailable(
        promotionError
          ?? new Error("R2 registration could not be promoted to ready"),
      );
    }
  }
  throw authorityUnavailable(
    promotionError ?? new Error("R2 registration could not be reconciled"),
  );
}

export interface RegisterManagedObjectInput {
  id: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  actorEmail: string;
  body: ReadableStream;
  findWinner: () => Promise<ReusableManagedObject | null>;
}

export interface ManagedObjectRegistration {
  object: ReusableManagedObject;
  deduplicated: boolean;
}

/**
 * Managed storage uses a failed metadata row as the non-public staging state.
 * The schema predates an explicit pending status, but failed rows are not
 * reusable and are now part of the ordinary tracked-GC surface.
 */
export async function registerManagedObject(
  env: Env,
  storage: ManagedStorage,
  input: RegisterManagedObjectInput,
): Promise<ManagedObjectRegistration> {
  const initialWinner = await findManagedWinner(input.findWinner);
  if (initialWinner) {
    return { object: initialWinner, deduplicated: true };
  }

  const now = new Date().toISOString();
  let candidate: ManagedRegistrationCandidate | null = null;
  let insertError: unknown;
  for (let attempt = 0; attempt < 2 && !candidate; attempt += 1) {
    try {
      await env.DB.prepare(`
        INSERT INTO managed_storage_objects (
          id, provider, object_key, original_name, mime_type, byte_size,
          sha256, status, actor_email, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?)
      `).bind(
        input.id,
        storage.provider,
        input.objectKey,
        input.originalName,
        input.mimeType,
        input.byteSize,
        input.sha256,
        input.actorEmail,
        now,
      ).run();
      candidate = {
        id: input.id,
        provider: storage.provider,
        object_key: input.objectKey,
        original_name: input.originalName,
        mime_type: input.mimeType,
        byte_size: input.byteSize,
        sha256: input.sha256,
        status: "failed",
      };
    } catch (error) {
      insertError = error;
      try {
        candidate = await readManagedRegistrationCandidate(env.DB, {
          id: input.id,
          provider: storage.provider,
          objectKey: input.objectKey,
          sha256: input.sha256,
          byteSize: input.byteSize,
        });
      } catch (verificationError) {
        throw authorityUnavailable(verificationError);
      }
      if (candidate) break;
      const winner = await findManagedWinner(input.findWinner);
      if (winner) return { object: winner, deduplicated: true };
      if (attempt === 1) throw authorityUnavailable(error);
    }
  }
  if (!candidate) {
    throw authorityUnavailable(
      insertError
        ?? new Error("Managed registration metadata could not be staged"),
    );
  }
  if (candidate.status === "ready" || candidate.status === "orphaned") {
    const { status: _status, ...object } = candidate;
    return { object, deduplicated: false };
  }

  const stored = await storage.put({
    key: input.objectKey,
    body: input.body,
    contentType: input.mimeType,
    filename: input.originalName,
    sha256: input.sha256,
    byteSize: input.byteSize,
  });
  if (stored.byteSize !== input.byteSize) {
    throw new ManagedRegistrationByteSizeMismatchError();
  }

  let promotionError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let promoted = false;
    try {
      const result = await env.DB.prepare(`
        UPDATE managed_storage_objects
        SET status = 'ready', orphaned_at = NULL
        WHERE id = ? AND provider = ? AND object_key = ?
          AND sha256 = ? AND byte_size = ? AND status = 'failed'
          AND NOT EXISTS (
            SELECT 1
            FROM managed_storage_objects winner
            WHERE winner.id <> managed_storage_objects.id
              AND winner.provider = managed_storage_objects.provider
              AND winner.sha256 = managed_storage_objects.sha256
              AND winner.byte_size = managed_storage_objects.byte_size
              AND winner.status IN ('ready', 'orphaned')
              AND NOT EXISTS (
                SELECT 1 FROM blob_integrity_quarantine biq
                WHERE biq.store_kind = 'managed'
                  AND biq.provider = winner.provider
                  AND biq.object_key = winner.object_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM blob_gc_ledger bg
                WHERE bg.store_kind = 'managed'
                  AND bg.provider = winner.provider
                  AND bg.object_key = winner.object_key
                  AND bg.state IN ('deleting', 'deleted')
              )
          )
      `).bind(
        input.id,
        storage.provider,
        input.objectKey,
        input.sha256,
        input.byteSize,
      ).run();
      promoted = Boolean(result.meta.changes);
    } catch (error) {
      promotionError = error;
    }
    if (promoted) {
      return {
        object: {
          id: input.id,
          provider: storage.provider,
          object_key: input.objectKey,
          original_name: input.originalName,
          mime_type: input.mimeType,
          byte_size: input.byteSize,
          sha256: input.sha256,
        },
        deduplicated: false,
      };
    }

    let exact: ManagedRegistrationCandidate | null;
    try {
      exact = await readManagedRegistrationCandidate(env.DB, {
        id: input.id,
        provider: storage.provider,
        objectKey: input.objectKey,
        sha256: input.sha256,
        byteSize: input.byteSize,
      });
    } catch (verificationError) {
      throw authorityUnavailable(verificationError);
    }
    if (exact?.status === "ready" || exact?.status === "orphaned") {
      const { status: _status, ...object } = exact;
      return { object, deduplicated: false };
    }

    const winner = await findManagedWinner(input.findWinner);
    if (winner) {
      return { object: winner, deduplicated: true };
    }
    if (attempt === 1) {
      throw authorityUnavailable(
        promotionError
          ?? new Error("Managed registration could not be promoted to ready"),
      );
    }
  }
  throw authorityUnavailable(
    promotionError ?? new Error("Managed registration could not be reconciled"),
  );
}
