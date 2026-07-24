import type { TemplateRecord } from "./api";
import type { TemplateFamilyGroup } from "./template-groups";

function searchTerms(query: string) {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function includesEveryTerm(values: Array<string | number | null | undefined>, query: string) {
  const terms = searchTerms(query);
  if (!terms.length) return true;
  const haystack = values.filter((value) => value != null).join(" ").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function matchesTemplateSearch(template: TemplateRecord, query: string) {
  const values = template.templateKind === "metrology"
    ? [
        template.name,
        "metrology",
        template.toolName,
        template.parametersText,
        template.commentsText,
      ]
    : [
        template.name,
        "process",
        "fabrication",
        template.templateType,
        template.sourceFilename,
        `v${template.version}`,
        `version ${template.version}`,
        `${template.stepCount} steps`,
        template.locked ? "locked" : "editable",
      ];
  return includesEveryTerm(values, query);
}

export function matchesTemplateFamilySearch(family: TemplateFamilyGroup, query: string) {
  return includesEveryTerm([
    family.name,
    family.templateType,
    "process",
    "fabrication",
  ], query);
}
