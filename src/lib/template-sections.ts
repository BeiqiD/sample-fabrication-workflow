export interface SectionedStep {
  sectionName: string | null;
}

const HIDDEN_SECTION_NAMES = new Set(["unnamed section"]);

export function normalizeSectionName(sectionName: string | null | undefined): string | null {
  const normalized = sectionName?.trim().replace(/\s+/g, " ");
  if (!normalized || HIDDEN_SECTION_NAMES.has(normalized.toLocaleLowerCase())) return null;
  return normalized;
}

export function sectionNameAtGroupStart(steps: SectionedStep[], index: number): string | null {
  const current = normalizeSectionName(steps[index]?.sectionName);
  if (!current) return null;
  const previous = normalizeSectionName(steps[index - 1]?.sectionName);
  return current === previous ? null : current;
}
