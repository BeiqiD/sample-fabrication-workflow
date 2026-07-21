import type { SampleDetail, SampleEvent, SampleSummary } from "../shared/types";

type SampleRow = {
  id: string;
  code: string;
  title: string;
  description?: string | null;
  status: SampleSummary["status"];
  location: string | null;
  parent_id: string | null;
  pinned: number;
  created_at?: string;
  updated_at: string;
  latest_workflow_name?: string | null;
  latest_workflow_version?: number | null;
  latest_run_status?: SampleSummary["latestRunStatus"];
  current_step_title?: string | null;
  current_state_step_title?: string | null;
  current_state_thumbnail_key?: string | null;
};

export function sampleSummary(row: SampleRow): SampleSummary {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    location: row.location,
    parentId: row.parent_id,
    pinned: Boolean(row.pinned),
    updatedAt: row.updated_at,
    latestWorkflowName: row.latest_workflow_name ?? null,
    latestWorkflowVersion: row.latest_workflow_version == null ? null : Number(row.latest_workflow_version),
    latestRunStatus: row.latest_run_status ?? null,
    currentStepTitle: row.current_step_title ?? null,
    currentStateStepTitle: row.current_state_step_title ?? null,
    currentStateThumbnailKey: row.current_state_thumbnail_key ?? null,
  };
}

export function sampleDetail(row: SampleRow): Omit<SampleDetail, "parent" | "children" | "events" | "runs" | "stateVerifications"> {
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
  metadata_json: string;
  actor_email?: string | null;
  created_at: string;
}): SampleEvent {
  return {
    id: row.id,
    sampleId: row.sample_id,
    kind: row.kind,
    body: row.body,
    assetKey: row.asset_key,
    metadata: JSON.parse(row.metadata_json || "{}") as Record<string, unknown>,
    actorEmail: row.actor_email ?? null,
    createdAt: row.created_at,
  };
}
