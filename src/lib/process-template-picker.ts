import type { ProcessTemplateVersionSummary } from "./api";

export function availableProcessTemplateVersions(
  versions: ProcessTemplateVersionSummary[],
  currentVersion?: number,
) {
  return currentVersion == null
    ? versions
    : versions.filter((version) => version.version > currentVersion);
}

export function selectedProcessTemplateVersionId(
  versions: ProcessTemplateVersionSummary[],
  currentId: string,
) {
  return versions.some((version) => version.id === currentId)
    ? currentId
    : versions[0]?.id || "";
}
