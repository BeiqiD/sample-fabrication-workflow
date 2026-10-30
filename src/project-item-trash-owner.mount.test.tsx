import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectItemLifecycleInput, ProjectItemMutationResponse } from "../shared/project-api";
import { readAuthentication } from "./lib/authentication-client";
import { projectApi } from "./lib/project-client";
import { projectActiveTrashSnapshot } from "./lib/project-item-trash";
import { useProjectItemTrash } from "./lib/use-project-item-trash";
import { projectTestSnapshot } from "./project-test-fixture";

const alice = "local_6f3e32c5-d935-44ab-8567-0966b13d91ae";
const bob = "local_3408b493-0ff6-41eb-8f8b-0cfe7bb4ef1a";
const at = "2026-10-18T00:00:00.000Z";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal("crypto", webcrypto); vi.stubEnv("VITE_LOCAL_AUTHENTICATION", "1"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); sessionStorage.clear(); });

describe("Project trash batch owner continuations", () => {
  it.each(["remove", "restore"] as const)("does not send the next %s under Bob's identity when Alice's first acknowledgement settles", async (kind) => {
    const state = projectTestSnapshot();
    if (kind === "restore") {
      for (const item of state.items) { item.deletedAt = at; item.deletedBy = alice; item.deletionOperationId = `earlier-${item.id}`; }
      for (const content of state.contents) { content.deletedAt = at; content.deletedBy = alice; }
    }
    let principal = alice;
    let acknowledgement!: Response;
    const first = deferred<Response>();
    const network = vi.fn<typeof fetch>().mockImplementation(async (path, init) => {
      const url = String(path);
      if (url === "/api/auth/session") return json({ principal: { id: principal, actor: `local-account:${principal}`,
        capabilities: { systemAdministrator: true, fileEvidenceOperator: false } }, csrf: (principal === alice ? "A" : "B").repeat(43) });
      if (url.startsWith("/api/projects/project-a?") && !init?.method) return json(state);
      const match = url.match(/^\/api\/projects\/project-a\/items\/([^/]+)(?:\/restore)?$/);
      if (!match || init?.method !== (kind === "remove" ? "DELETE" : "POST")) throw new Error(`Unexpected fixture request: ${url}`);
      const input = JSON.parse(String(init.body)) as ProjectItemLifecycleInput;
      const item = state.items.find((candidate) => candidate.id === match[1])!;
      const content = state.contents.find((candidate) => candidate.id === item.projectContentId) ?? null;
      expect(input.expectedItemRevision).toBe(item.revision);
      if (content) expect(input.expectedContentRevision).toBe(content.revision);
      item.revision += 1; item.deletedAt = kind === "remove" ? at : null;
      item.deletedBy = kind === "remove" ? alice : null;
      item.deletionOperationId = kind === "remove" ? input.operationId : null;
      if (content) { content.revision += 1; content.deletedAt = item.deletedAt; content.deletedBy = item.deletedBy; }
      const result: ProjectItemMutationResponse = structuredClone({ item, content, attachment: null,
        placement: state.placements.find((candidate) => candidate.projectItemId === item.id)!, project: state.project, replayed: false });
      const response = json(result);
      if (item.id === state.items[0].id) { acknowledgement = response; return first.promise; }
      return response;
    });
    vi.stubGlobal("fetch", network);
    await readAuthentication();
    const mutation = vi.spyOn(projectApi, kind === "remove" ? "removeItem" : "restoreItem");
    const reads = vi.spyOn(projectApi, "readTrash");
    const onItemRemoved = vi.fn(), onItemRestored = vi.fn(), onEdgeRestored = vi.fn(), onAuthoritativeSnapshot = vi.fn();
    const view = renderHook(() => useProjectItemTrash({
      projectId: state.project.id, snapshot: projectActiveTrashSnapshot(state), externalBusy: false,
      onItemRemoved, onItemRestored, onEdgeRestored, onAuthoritativeSnapshot,
    }));
    const writes = () => network.mock.calls.filter(([, init]) => init?.method === "DELETE" || init?.method === "POST");
    try {
      act(() => {
        const ids = state.items.map((item) => item.id);
        expect(kind === "remove" ? view.result.current.removeItems(ids) : view.result.current.restoreItems(ids)).toBe(true);
      });
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(new Headers(writes()[0][1]?.headers).get("x-sfw-csrf")).toBe("A".repeat(43));
      // Do not unmount, rerender with another Project, or trigger gate cleanup.
      await act(async () => { principal = bob; await readAuthentication(); });
      await act(async () => {
        first.resolve(acknowledgement);
        await mutation.mock.results[0].value;
        await Promise.allSettled(mutation.mock.results.map((result) => result.value));
        await Promise.allSettled(reads.mock.results.map((result) => result.value));
      });
      expect.soft(writes()).toHaveLength(1);
      expect.soft(mutation.mock.calls.map((call) => call[1])).toEqual([state.items[0].id]);
      expect(onItemRemoved).not.toHaveBeenCalled(); expect(onItemRestored).not.toHaveBeenCalled();
      expect(onEdgeRestored).not.toHaveBeenCalled(); expect(onAuthoritativeSnapshot).not.toHaveBeenCalled();
    } finally {
      first.resolve(acknowledgement);
      await Promise.allSettled(mutation.mock.results.map((result) => result.value));
    }
  });
});
