import { HTTPException } from "hono/http-exception";
import { primaryD1 } from "../d1-primary";
import { publishedAssetSql } from "../template-publication";
import { readFileAuthorityMode } from "./authority-reader";

/** Accept a business alias ID or a real legacy R2 key. Native destinations are
 * resolved by the server; callers never submit provider URLs or File bindings. */
export async function readReadyAssetInput(database: D1Database, input: { assetId?: unknown; assetKey?: unknown }) {
  const supplied = [input.assetId, input.assetKey].filter(value => value !== undefined);
  if (!supplied.length) return null;
  if (supplied.length !== 1 || typeof supplied[0] !== "string" || !supplied[0] || supplied[0].length > 4096 || supplied[0].includes("\0")) {
    throw new HTTPException(400, { message: "One valid file attachment is required" });
  }
  const active = await readFileAuthorityMode(database) === "active";
  const asset = await primaryD1(database).prepare(`SELECT a.id,a.r2_key,a.sha256 FROM assets a
    WHERE ${input.assetId !== undefined ? "a.id" : "a.r2_key"}=? AND a.status='ready' AND ${publishedAssetSql("a")}
      ${active ? "" : `AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger g WHERE g.store_kind='r2' AND g.provider='r2'
        AND g.object_key=a.r2_key AND g.state IN('deleting','deleted'))
        AND NOT EXISTS(SELECT 1 FROM blob_integrity_quarantine q WHERE q.store_kind='r2' AND q.provider='r2' AND q.object_key=a.r2_key)`}`)
    .bind(supplied[0]).first<{ id: string; r2_key: string | null; sha256: string }>();
  if (asset?.r2_key === null && !active) return null;
  return asset;
}
