// @vitest-environment jsdom
import { useState } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import {
  createMarkdownProjectItem, createProject, createProjectEdge, deleteProjectEdge,
  readProjectSnapshot, updateProjectEdge,
} from "./projects/service";
import { ProjectApiError, projectApi } from "../src/lib/project-client";
import { useProjectEdgeController } from "../src/lib/use-project-edge-controller";

const actor = "review@example.com";
const now = "2026-09-12T12:00:00.000Z";

function testDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = `${process.cwd()}/migrations`;
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${directory}/${file}`, "utf8"));
  }
  function statement(sql: string, values: unknown[] = []) {
    const execute = () => {
      const prepared = database.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { results: prepared.all(...values as []), success: true, meta: { changes: 0 } };
      return { results: [], success: true, meta: { changes: Number(prepared.run(...values as []).changes) } };
    };
    return {
      bind: (...bindings: unknown[]) => statement(sql, bindings),
      execute, run: async () => execute(), all: async () => execute(),
      first: async () => database.prepare(sql).get(...values as []) ?? null,
    };
  }
  const db = {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      database.exec("BEGIN");
      try { const results = statements.map((statement) => statement.execute()); database.exec("COMMIT"); return results; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return { database, db };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Adversarial connection recovery review", () => {
  it("keeps an unacknowledged reconnect frozen after a reversible duplicate rejection", async () => {
    const { database, db } = testDatabase();
    await createProject(db, { id: "review-project", title: "Review", operationId: "create-project" }, actor, now);
    for (const [index, suffix] of ["a", "b", "c"].entries()) {
      await createMarkdownProjectItem(db, "review-project", {
        itemId: `item-${suffix}`, contentId: `content-${suffix}`, placementId: `placement-${suffix}`,
        markdownSource: suffix, geometry: { x: 0, y: 0, width: 320, height: 180, zIndex: 0 },
        expectedProjectRevision: index + 1, operationId: `create-${suffix}`,
      }, actor, now);
    }
    const metadata = { markerStart: "none" as const, markerEnd: "arrow" as const, label: "supports" };
    const before = { sourceItemId: "item-a", targetItemId: "item-b", sourceHandle: "right" as const, targetHandle: "left" as const };
    const after = { ...before, targetItemId: "item-c" };
    await createProjectEdge(db, "review-project", {
      edgeId: "edge-original", ...before, ...metadata,
      expectedSourceItemRevision: 1, expectedTargetItemRevision: 1, operationId: "create-original",
    }, actor, now);
    const initial = await readProjectSnapshot(db, "review-project");
    vi.spyOn(projectApi, "readTrash").mockImplementation((projectId) => readProjectSnapshot(db, projectId, true));
    let releaseWrite!: () => void;
    let signalEntered!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const pausedDb = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!/^\s*UPDATE project_edges\b/.test(sql)) return statement;
        return {
          bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return {
              async run() { signalEntered(); await writeGate; return bound.run(); },
            };
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    let originalWrite!: ReturnType<typeof updateProjectEdge>;
    const update = vi.spyOn(projectApi, "updateEdge")
      .mockImplementationOnce(async (projectId, edgeId, input) => {
        originalWrite = updateProjectEdge(pausedDb, projectId, edgeId, input, actor, now);
        await writeEntered;
        throw new TypeError("Connection closed while the original request was still executing");
      })
      .mockImplementation(async (projectId, edgeId, input) => {
        try { return await updateProjectEdge(db, projectId, edgeId, input, actor, now); }
        catch (caught) { throw new ProjectApiError((caught as Error).message, 409); }
      });
    const { result } = renderHook(() => {
      const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(initial);
      const controller = useProjectEdgeController({
        projectId: "review-project", snapshot, setSnapshot, externalBusy: false, onHistory: vi.fn(),
      });
      return { controller, snapshot, setSnapshot };
    });
    act(() => { expect(result.current.controller.reconnect("edge-original", after)).toBe(true); });
    await waitFor(() => expect(result.current.controller.pending?.status).toBe("uncertain"));
    const frozenInput = update.mock.calls[0]![2];
    await createProjectEdge(db, "review-project", {
      edgeId: "edge-temporary-duplicate", ...after, ...metadata,
      expectedSourceItemRevision: 1, expectedTargetItemRevision: 1, operationId: "create-duplicate",
    }, actor, now);
    act(() => result.current.controller.retryExact());
    await waitFor(() => expect(result.current.controller.pending?.status).not.toBe("saving"));
    const observedStatus = result.current.controller.pending?.status;
    expect(update.mock.calls[1]![2]).toEqual(frozenInput);
    expect(database.prepare("SELECT revision FROM project_edges WHERE id = 'edge-original'").get())
      .toEqual({ revision: 1 });
    // This is precisely the Reload action enabled by the conflict state.
    if (observedStatus === "conflict") {
      const fresh = await readProjectSnapshot(db, "review-project");
      act(() => {
        result.current.controller.resetForAuthoritativeReload();
        result.current.setSnapshot(fresh);
      });
      expect(result.current.controller.unsafe).toBe(false);
    }
    await deleteProjectEdge(db, "review-project", "edge-temporary-duplicate", {
      expectedRevision: 1, operationId: "remove-duplicate",
    }, actor, now);
    releaseWrite();
    const lateCommit = await originalWrite;
    expect(lateCommit.value).toMatchObject({ ...after, revision: 2 });
    expect(result.current.snapshot!.edges.find((edge) => edge.id === "edge-original"))
      .toMatchObject({ ...before, revision: 1 });
    // A transient duplicate changes neither the frozen edge nor endpoint revisions.
    // The original request can still commit, so Reload must remain unavailable.
    expect(observedStatus).toBe("uncertain");
    expect(result.current.controller.unsafe).toBe(true);
    act(() => result.current.controller.retryExact());
    await waitFor(() => expect(result.current.controller.pending).toBe(null));
    expect(update.mock.calls[2]![2]).toEqual(frozenInput);
    expect(result.current.snapshot!.edges.find((edge) => edge.id === "edge-original"))
      .toMatchObject({ ...after, revision: 2 });
    expect(result.current.controller.unsafe).toBe(false);
    database.close();
  });
});
