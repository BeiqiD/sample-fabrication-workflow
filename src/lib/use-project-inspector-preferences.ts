import { useCallback, useState } from "react";

export interface ProjectInspectorPreferences {
  panelOpen: boolean;
  pinned: boolean;
  detailsOpen: boolean;
  previewExpanded: boolean;
  moreActionsOpen: boolean;
  arrangeOpen: boolean;
}

const defaultPreferences: ProjectInspectorPreferences = {
  panelOpen: false,
  pinned: false,
  detailsOpen: false,
  previewExpanded: false,
  moreActionsOpen: false,
  arrangeOpen: false,
};

// UI choices belong to the Project session, rather than to the selected card or
// a temporary panel mount. No content or draft is retained here.
export function useProjectInspectorPreferences(projectId: string) {
  const [sessions, setSessions] = useState<Record<string, ProjectInspectorPreferences>>({});
  const preferences = sessions[projectId] ?? defaultPreferences;
  const setPreference = useCallback((key: keyof ProjectInspectorPreferences, value: boolean) => {
    setSessions((current) => {
      const previous = current[projectId] ?? defaultPreferences;
      if (previous[key] === value) return current;
      return { ...current, [projectId]: { ...previous, [key]: value } };
    });
  }, [projectId]);
  return { preferences, setPreference };
}
