import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ProjectReferenceRecord, ProjectSnapshot } from "../../shared/project-api";
import { resolveReference } from "./reference-api";

function isActivePreview(
  snapshot: ProjectSnapshot | null,
  projectId: string,
  preview: ProjectReferenceRecord,
) {
  return snapshot?.project.id === projectId
    && snapshot.references.includes(preview)
    && snapshot.items.some((item) => item.itemType === "reference"
      && item.deletedAt === null && item.referenceTargetId === preview.registryId);
}

/** Resolve acknowledged insertions without replacing the local working snapshot. */
export function useProjectReferenceHydration(
  projectId: string,
  snapshot: ProjectSnapshot | null,
  setSnapshot: Dispatch<SetStateAction<ProjectSnapshot | null>>,
) {
  const currentRef = useRef({ projectId, snapshot });
  currentRef.current = { projectId, snapshot };
  const requestsRef = useRef(new Map<ProjectReferenceRecord, AbortController>());
  const [failures, setFailures] = useState<ProjectReferenceRecord[]>([]);

  useEffect(() => {
    const requests = requestsRef.current;
    setFailures([]);
    return () => {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
    };
  }, [projectId]);

  const hydrate = useCallback((preview: ProjectReferenceRecord) => {
    requestsRef.current.get(preview)?.abort();
    const controller = new AbortController();
    requestsRef.current.set(preview, controller);
    setFailures((current) => current.filter((failure) => failure !== preview));
    const target = preview.resolution.target;
    void resolveReference(target, controller.signal).then((resolution) => {
      if (controller.signal.aborted || currentRef.current.projectId !== projectId) return;
      if (resolution.target.type !== target.type || resolution.target.id !== target.id) {
        throw new Error("Reference resolution returned a different target");
      }
      // Object identity is the request token: a new authoritative snapshot or
      // another resolution invalidates it, while independent insertions do not.
      setSnapshot((current) => isActivePreview(current, projectId, preview)
        ? { ...current!, references: current!.references.map((reference) => (
          reference === preview ? { registryId: preview.registryId, resolution } : reference
        )) }
        : current);
    }).catch(() => {
      if (controller.signal.aborted || currentRef.current.projectId !== projectId) return;
      // The insertion is already committed. Retrying this read must never
      // replay its mutation or discard geometry edited while it was loading.
      setFailures((current) => [...current.filter((failure) => failure !== preview), preview]);
    }).finally(() => {
      if (requestsRef.current.get(preview) === controller) requestsRef.current.delete(preview);
    });
  }, [projectId, setSnapshot]);

  return {
    hydrate,
    failures: failures.filter((preview) => isActivePreview(snapshot, projectId, preview)),
  };
}
