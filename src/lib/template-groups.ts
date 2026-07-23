import type { TemplateRecord } from "./api";

export interface TemplateFamilyGroup {
  recipeFamilyId: string;
  name: string;
  templateType: TemplateRecord["templateType"];
  latestVersion: number;
  versions: TemplateRecord[];
}

export function groupTemplateVersions(templates: TemplateRecord[]): TemplateFamilyGroup[] {
  const families = new Map<string, TemplateRecord[]>();
  for (const template of templates) {
    families.set(template.recipeFamilyId, [...(families.get(template.recipeFamilyId) ?? []), template]);
  }

  return [...families.entries()]
    .map(([recipeFamilyId, familyVersions]) => {
      const versions = [...familyVersions].sort((left, right) =>
        right.version - left.version || right.createdAt.localeCompare(left.createdAt));
      const latest = versions[0];
      return {
        recipeFamilyId,
        name: latest.name,
        templateType: latest.templateType,
        latestVersion: latest.version,
        versions,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name)
      || left.templateType.localeCompare(right.templateType)
      || left.recipeFamilyId.localeCompare(right.recipeFamilyId));
}
