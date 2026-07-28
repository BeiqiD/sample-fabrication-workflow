export interface SectionedStep {
  sectionName: string | null;
}

const HIDDEN_SECTION_NAMES = new Set(["unnamed section"]);
export const UNNAMED_SECTION_LABEL = "Other steps";

export interface SectionGroup {
  key: string;
  name: string | null;
  label: string;
  startIndex: number;
  endIndex: number;
}

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

export function sectionGroups(steps: SectionedStep[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const name = normalizeSectionName(steps[index]?.sectionName);
    const previous = groups.at(-1);
    if (previous && previous.name === name) {
      previous.endIndex = index;
      continue;
    }
    groups.push({
      key: `${groups.length}:${name ?? "unsectioned"}`,
      name,
      label: name ?? UNNAMED_SECTION_LABEL,
      startIndex: index,
      endIndex: index,
    });
  }
  return groups;
}

export function visibleSectionGroups(steps: SectionedStep[]): SectionGroup[] {
  const groups = sectionGroups(steps);
  return groups.length > 1 ? groups : [];
}

export function sectionHeaderAtGroupStart(steps: SectionedStep[], index: number): string | null {
  return visibleSectionGroups(steps).find((group) => group.startIndex === index)?.label ?? null;
}
