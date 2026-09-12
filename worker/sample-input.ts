import { isSampleStatus, type CreateSampleInput, type UpdateSampleInput } from "../shared/types";

type SampleInputValidation<T> =
  | { ok: true; input: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateCreateSampleInput(value: unknown): SampleInputValidation<CreateSampleInput> {
  if (!isRecord(value)
    || typeof value.code !== "string"
    || typeof value.title !== "string"
    || (value.description !== undefined && typeof value.description !== "string")
    || (value.location !== undefined && typeof value.location !== "string")
    || (value.status !== undefined && !isSampleStatus(value.status))) {
    return { ok: false, error: "Invalid sample fields" };
  }
  const code = value.code.trim();
  const title = value.title.trim();
  if (!code || !title) return { ok: false, error: "Code and sample name are required" };
  if (code.length > 100 || title.length > 200
    || (value.description?.length ?? 0) > 10_000
    || (value.location?.length ?? 0) > 500) {
    return { ok: false, error: "One or more sample fields are too long" };
  }
  return {
    ok: true,
    input: {
      code: value.code,
      title: value.title,
      description: value.description,
      location: value.location,
      status: value.status,
    },
  };
}

export function validateUpdateSampleInput(value: unknown): SampleInputValidation<UpdateSampleInput> {
  if (!isRecord(value)) return { ok: false, error: "Invalid sample update" };
  if ("code" in value) {
    return { ok: false, error: "Sample code is a permanent identifier and cannot be changed" };
  }
  if (typeof value.expectedUpdatedAt !== "string"
    || (value.title !== undefined && typeof value.title !== "string")
    || (value.description !== undefined && typeof value.description !== "string")
    || (value.location !== undefined && typeof value.location !== "string")
    || (value.pinned !== undefined && typeof value.pinned !== "boolean")) {
    return { ok: false, error: "Invalid sample update" };
  }
  if (value.title !== undefined && (!value.title.trim() || value.title.length > 200)) {
    return { ok: false, error: "Sample name is required and must be 200 characters or fewer" };
  }
  if (value.description !== undefined && value.description.length > 10_000) {
    return { ok: false, error: "Description is too long" };
  }
  if (value.location && value.location.length > 500) return { ok: false, error: "Location is too long" };
  if (value.status !== undefined && !isSampleStatus(value.status)) {
    return { ok: false, error: "Invalid sample status" };
  }
  return {
    ok: true,
    input: {
      expectedUpdatedAt: value.expectedUpdatedAt,
      title: value.title,
      description: value.description,
      location: value.location,
      pinned: value.pinned,
      status: value.status,
    },
  };
}
