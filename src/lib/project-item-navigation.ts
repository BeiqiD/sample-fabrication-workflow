import { MAX_PROJECT_ID_LENGTH } from "../../shared/project-types";

export const PROJECT_ITEM_FOCUS_QUERY_PARAM = "focus" as const;

export type ProjectItemFocusRequest =
  | { status: "none"; itemId: null }
  | { status: "invalid"; itemId: null }
  | { status: "valid"; itemId: string };

const PROJECT_ITEM_FOCUS_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function isProjectItemFocusId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PROJECT_ID_LENGTH
    && value.trim() === value
    && !PROJECT_ITEM_FOCUS_CONTROL_CHARACTER.test(value);
}

export function projectItemFocusRequest(search: string): ProjectItemFocusRequest {
  const values = new URLSearchParams(search).getAll(PROJECT_ITEM_FOCUS_QUERY_PARAM);
  if (values.length === 0) return { status: "none", itemId: null };
  if (values.length !== 1 || !isProjectItemFocusId(values[0])) {
    return { status: "invalid", itemId: null };
  }
  return { status: "valid", itemId: values[0] };
}

export function projectItemFocusPath(projectPathname: string, itemId: string) {
  if (!isProjectItemFocusId(itemId)) {
    throw new TypeError("Project item focus identity is invalid");
  }
  const params = new URLSearchParams();
  params.set(PROJECT_ITEM_FOCUS_QUERY_PARAM, itemId);
  return `${projectPathname}?${params.toString()}`;
}

export function projectItemFocusAbsoluteUrl(
  origin: string,
  projectPathname: string,
  itemId: string,
) {
  return new URL(projectItemFocusPath(projectPathname, itemId), origin).toString();
}
