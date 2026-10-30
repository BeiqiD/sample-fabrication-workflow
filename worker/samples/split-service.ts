import { HTTPException } from "hono/http-exception";
import { isSampleStatus, MAX_SPLIT_PIECES, type SplitSampleInput } from "../../shared/types";
import { loadCurrentSampleStructureSql } from "../application/sample-structure-read";
import { prepareSplitInheritedStateWithDatabase } from "./split-inherited-state";
import type { SampleSplitCapabilities, SampleSplitStatement } from "./split-sql";

/** Full original split normalization, source-selection/CAS, inherited diagram
 * changes() adjacency, child audit and parent status algorithm. The owner only
 * supplies admission, exact cells/atomic acknowledgement and optional authority
 * rows coupled to the original batch; it cannot replace source metadata. */
export function createSampleSplitService(capabilities: SampleSplitCapabilities) {
  return { async split(parentId: string, value: unknown, actor: string) {
    const input = value as SplitSampleInput;
    if (!input || typeof input.expectedUpdatedAt !== "string"
      || (input.parentStatusAfter !== "active" && input.parentStatusAfter !== "consumed")
      || !Array.isArray(input.pieces) || input.pieces.length < 1 || input.pieces.length > MAX_SPLIT_PIECES) {
      throw new HTTPException(400, { message: `A split requires 1–${MAX_SPLIT_PIECES} valid pieces and a parent status` });
    }

    const pieces = input.pieces.map((piece) => {
      if (!piece || typeof piece !== "object" || typeof piece.code !== "string" || typeof piece.title !== "string"
        || typeof piece.location !== "string" || !isSampleStatus(piece.status)
        || (piece.description !== undefined && typeof piece.description !== "string")) {
        throw new HTTPException(400, { message: "Every split piece needs valid sample fields" });
      }
      const normalized = {
        code: piece.code.trim(),
        title: piece.title.trim(),
        description: piece.description?.trim() || null,
        location: piece.location.trim(),
        status: piece.status,
      };
      if (!normalized.code || !normalized.title || !normalized.location) {
        throw new HTTPException(400, { message: "Every split piece needs a code, sample name, and location" });
      }
      if (normalized.code.length > 100 || normalized.title.length > 200 || (normalized.description?.length ?? 0) > 10_000 || normalized.location.length > 500) {
        throw new HTTPException(400, { message: "One or more split-piece fields are too long" });
      }
      return normalized;
    });
    const normalizedCodes = pieces.map((piece) => piece.code.toLocaleLowerCase());
    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
      throw new HTTPException(409, { message: "Every new piece must have a unique sample code" });
    }

    // Freeze the validated original selectors before any asynchronous source read.
    const expectedUpdatedAt = input.expectedUpdatedAt, parentStatusAfter = input.parentStatusAfter;
    await capabilities.admit(actor);
    const db = capabilities.database();
    const [parent, parentStructure] = await Promise.all([
      db.prepare(
        "SELECT code, updated_at FROM samples WHERE id = ? AND deleted_at IS NULL",
      ).bind(parentId).first(),
      loadCurrentSampleStructureSql(capabilities, parentId),
    ]);
    if (!parent) throw new HTTPException(404, { message: "Parent sample not found" });
    if (typeof parent.code !== "string" || typeof parent.updated_at !== "string") throw new TypeError("Invalid original split parent metadata");
    if (parent.updated_at !== expectedUpdatedAt) {
      throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
    }

    const now = new Date(capabilities.now()).toISOString();
    const userEmail = actor;
    const mutationId = capabilities.randomId();
    const children = pieces.map((piece) => ({ ...piece, id: capabilities.randomId() }));
    const inherited = await prepareSplitInheritedStateWithDatabase(capabilities, parentId, expectedUpdatedAt, parentStructure, now);
    const statements: SampleSplitStatement[] = [...inherited.statements];
    for (const child of children) {
      statements.push(
        db.prepare(
          `INSERT INTO samples
            (id, code, title, description, status, location, parent_id, inherited_state_hash,
             created_by, updated_by, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, id, ?, ?, ?, ?, ?
           FROM samples WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
             AND ${inherited.guardSql}`,
        ).bind(child.id, child.code, child.title, child.description, child.status, child.location,
          inherited.stateHash, userEmail, userEmail, now, now, parentId, expectedUpdatedAt, ...inherited.guardBindings),
        db.prepare(
          `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
           SELECT ?, id, 'created', ?, ?, ?, ? FROM samples
           WHERE id = ? AND parent_id = ? AND deleted_at IS NULL`,
        ).bind(
          capabilities.randomId(), `Created by splitting parent ${parent.code}`,
          JSON.stringify({
            action: "created_by_split",
            parentId,
            parentCode: parent.code,
            inheritedStateHash: inherited.stateHash,
          }), userEmail, now, child.id, parentId,
        ),
      );
    }
    const childCodes = children.map((child) => child.code);
    statements.push(
      db.prepare(
        `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, id, 'status', ?, ?, ?, ? FROM samples
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
           AND ${inherited.guardSql}`,
      ).bind(
        capabilities.randomId(), `Split into ${children.length} child samples: ${childCodes.join(", ")}`,
        JSON.stringify({ action: "sample_split", childIds: children.map((child) => child.id), childCodes, parentStatusAfter: parentStatusAfter }),
        userEmail, now, parentId, expectedUpdatedAt, ...inherited.guardBindings,
      ),
      db.prepare(
        `UPDATE samples SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL
           AND ${inherited.guardSql}`,
      ).bind(parentStatusAfter, userEmail, mutationId, now, parentId, expectedUpdatedAt, ...inherited.guardBindings),
    );

    try {
      await capabilities.admit(actor);
      const results = capabilities.commitSplit
        ? await capabilities.commitSplit(Object.freeze({ parentId, childIds: Object.freeze(children.map(child => child.id)), actor, createdAt: now }), statements)
        : await db.batch(statements);
      if (!results.at(-1)?.meta.changes) {
        throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before splitting." });
      }
      if (results.slice(inherited.statements.length).some((result) => !result.meta.changes)) throw new Error("The complete split audit trail was not created");
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: "One or more generated sample codes already exist" });
      throw error;
    }
    await capabilities.admit(actor);
    return { children: children.map(({ id, code }) => ({ id, code })), updatedAt: now };
  } };
}
