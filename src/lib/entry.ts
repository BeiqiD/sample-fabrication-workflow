import type { SampleStatus } from "../../shared/types";

export function normalizeLocation(value: string) {
  return value.trim() || null;
}

export function sampleDetailsChanged(
  current: { status: SampleStatus; location: string | null; pinned: boolean },
  next: { status: SampleStatus; location: string; pinned: boolean },
) {
  return current.status !== next.status || current.location !== normalizeLocation(next.location) || current.pinned !== next.pinned;
}
