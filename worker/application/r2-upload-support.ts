import { HTTPException } from "hono/http-exception";
import { sha256Hex } from "../../shared/content-addressing";
import { BlobReuseProviderUnavailableError, findReusableR2Asset } from "../blob-lifecycle/reuse";
import type { Env } from "../types";

// Shared upload application helpers for FabuBlox and metrology references.
export async function digestSha256(buffer: ArrayBuffer) {
  return sha256Hex(buffer);
}

export async function reusableR2Asset(env: Env, sha256: string) {
  try {
    return await findReusableR2Asset(env, sha256);
  } catch (error) {
    if (error instanceof BlobReuseProviderUnavailableError) {
      throw new HTTPException(503, { message: error.message });
    }
    throw error;
  }
}

export function safeObjectName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
