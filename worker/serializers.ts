import { nativeAssetUrl } from "../shared/contracts/r2-upload";
import type { SampleDetail, SampleEvent, SampleSummary } from "../shared/types";

type SampleRow = {
  id: string;
  code: string;
  title: string;
  description?: string | null;
  status: SampleSummary["status"];
  location: string | null;
  parent_id: string | null;
  inherited_state_hash?: string | null;
  pinned: number;
  created_at?: string;
  updated_at: string;
  latest_workflow_name?: string | null;
  latest_workflow_version?: number | null;
  latest_run_status?: SampleSummary["latestRunStatus"];
  current_step_title?: string | null;
  current_state_step_title?: string | null;
  current_state_thumbnail_key?: string | null;
  current_state_thumbnail_json?: string | null;
};

export function sampleSummary(row: SampleRow): SampleSummary {
  const thumbnail = row.current_state_thumbnail_json ? JSON.parse(row.current_state_thumbnail_json) as {
    assetId: string; fileId: string | null; key: string | null;
  } : null;
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    location: row.location,
    parentId: row.parent_id,
    inheritedStateHash: row.inherited_state_hash ?? null,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at ?? row.updated_at,
    updatedAt: row.updated_at,
    latestWorkflowName: row.latest_workflow_name ?? null,
    latestWorkflowVersion: row.latest_workflow_version == null ? null : Number(row.latest_workflow_version),
    latestRunStatus: row.latest_run_status ?? null,
    currentStepTitle: row.current_step_title ?? null,
    currentStateStepTitle: row.current_state_step_title ?? null,
    currentStateThumbnailKey: thumbnail?.key ?? row.current_state_thumbnail_key ?? null,
    ...(thumbnail && thumbnail.key === null && thumbnail.fileId ? {
      currentStateThumbnailUrl: nativeAssetUrl(thumbnail.assetId),
    } : {}),
  };
}

export function sampleDetail(row: SampleRow): Omit<SampleDetail, "parent" | "children" | "events" | "runs" | "stateVerifications" | "comments"> {
  return {
    ...sampleSummary(row),
    description: row.description ?? null,
    createdAt: row.created_at ?? row.updated_at,
  };
}

export function sampleEvent(row: {
  id: string;
  sample_id: string;
  kind: SampleEvent["kind"];
  body: string | null;
  asset_key: string | null;
  asset_file_id?: string | null;
  thumbnail_file_id?: string | null;
  metadata_json: string;
  actor_email?: string | null;
  created_at: string;
}): SampleEvent {
  const metadata = JSON.parse(row.metadata_json || "{}") as Record<string, unknown>;
  const attachmentHidden = Boolean(metadata.deletedAt || metadata.assetDeletedAt);
  if (attachmentHidden) delete metadata.thumbnailKey;
  return {
    id: row.id,
    sampleId: row.sample_id,
    kind: row.kind,
    body: row.body,
    assetKey: attachmentHidden ? null : row.asset_key,
    ...(!attachmentHidden && !row.asset_key && row.asset_file_id && typeof metadata.assetId === "string" ? {
      assetId: metadata.assetId, fileId: row.asset_file_id, assetUrl: nativeAssetUrl(metadata.assetId),
    } : {}),
    ...(!attachmentHidden && row.thumbnail_file_id && typeof metadata.thumbnailAssetId === "string" ? {
      thumbnailUrl: nativeAssetUrl(metadata.thumbnailAssetId),
    } : {}),
    metadata,
    actorEmail: row.actor_email ?? null,
    createdAt: row.created_at,
  };
}
