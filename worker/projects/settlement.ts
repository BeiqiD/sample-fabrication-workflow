import { ProjectServiceError } from "./service";

export type SettlementProof = () => Promise<boolean>;

type ProjectFailure = {
  code: "not_found" | "conflict";
  message: string;
  authoritativeRejection: boolean;
};

function isDatabaseConflict(error: unknown) {
  return /(SQLITE_CONSTRAINT|constraint failed|UNIQUE constraint|FOREIGN KEY constraint|project item deletion requires|project item restore requires|project edge endpoints|reference target is unavailable|blob locator is unavailable|blob locator is quarantined)/i
    .test(String(error));
}

export function anySettlementProof(...proofs: SettlementProof[]): SettlementProof {
  return async () => {
    for (const proof of proofs) {
      if (await proof()) return true;
    }
    return false;
  };
}

export function projectRevisionSettlementProof(
  db: D1Database,
  projectId: string,
  expectedRevision: number,
): SettlementProof {
  return async () => {
    const row = await db.prepare(`
      SELECT revision FROM projects WHERE id = ? LIMIT 1
    `).bind(projectId).first<{ revision: number }>();
    return Boolean(row && Number(row.revision) > expectedRevision);
  };
}

export function projectItemIdentitySettlementProof(
  db: D1Database,
  input: {
    itemId: string;
    placementId: string;
    contentId?: string;
  },
): SettlementProof {
  return async () => {
    const row = await db.prepare(`
      SELECT 1 AS occupied
      WHERE EXISTS (SELECT 1 FROM project_items WHERE id = ?)
         OR EXISTS (SELECT 1 FROM project_map_placements WHERE id = ?)
         OR (? IS NOT NULL AND EXISTS (
           SELECT 1 FROM project_contents WHERE id = ?
         ))
      LIMIT 1
    `).bind(
      input.itemId,
      input.placementId,
      input.contentId ?? null,
      input.contentId ?? null,
    ).first<{ occupied: number }>();
    return Boolean(row);
  };
}

export function placementRevisionSettlementProof(
  db: D1Database,
  projectId: string,
  placementId: string,
  expectedRevision: number,
): SettlementProof {
  return async () => {
    const row = await db.prepare(`
      SELECT pmp.revision
      FROM project_map_placements pmp
      JOIN project_items pi ON pi.id = pmp.project_item_id
      WHERE pmp.id = ? AND pi.project_id = ?
      LIMIT 1
    `).bind(placementId, projectId).first<{ revision: number }>();
    return Boolean(row && Number(row.revision) > expectedRevision);
  };
}

export function edgeIdentitySettlementProof(
  db: D1Database,
  edgeId: string,
): SettlementProof {
  return async () => Boolean(await db.prepare(`
    SELECT 1 AS occupied FROM project_edges WHERE id = ? LIMIT 1
  `).bind(edgeId).first<{ occupied: number }>());
}

export function edgeEndpointRevisionSettlementProof(
  db: D1Database,
  projectId: string,
  input: {
    sourceItemId: string;
    targetItemId: string;
    expectedSourceItemRevision: number;
    expectedTargetItemRevision: number;
  },
): SettlementProof {
  return async () => {
    const result = await db.prepare(`
      SELECT id, revision
      FROM project_items
      WHERE project_id = ? AND id IN (?, ?)
    `).bind(projectId, input.sourceItemId, input.targetItemId).all<{
      id: string;
      revision: number;
    }>();
    const revisions = new Map(result.results.map((row) => [row.id, Number(row.revision)]));
    const sourceRevision = revisions.get(input.sourceItemId);
    const targetRevision = revisions.get(input.targetItemId);
    return (sourceRevision !== undefined && sourceRevision > input.expectedSourceItemRevision)
      || (targetRevision !== undefined && targetRevision > input.expectedTargetItemRevision);
  };
}

export async function classifyProjectFailure(
  error: unknown,
  settlementProof?: SettlementProof,
): Promise<ProjectFailure | null> {
  if (error instanceof ProjectServiceError) {
    if (error.code === "not_found") {
      return { code: "not_found", message: error.message, authoritativeRejection: false };
    }
    let authoritativeRejection = false;
    if (settlementProof) {
      try {
        authoritativeRejection = await settlementProof();
      } catch {
        // Settlement metadata is safety-only. Failure to prove an immutable
        // identity fence or a strictly advanced revision must remain uncertain.
        authoritativeRejection = false;
      }
    }
    return { code: "conflict", message: error.message, authoritativeRejection };
  }
  if (isDatabaseConflict(error)) {
    return {
      code: "conflict",
      message: "Project state changed before the operation could commit",
      authoritativeRejection: false,
    };
  }
  return null;
}
